import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { getGrant } from './db';

const DOCKER_SOCKET = '/var/run/docker.sock';
const proxyServers = new Map<string, net.Server>();

// ── Devcontainer registry ─────────────────────────────────────────────────────
// All known devcontainer identifiers (name + full ID + short ID).
// Operations targeting any of these are blocked — containers may only
// spawn and manage their OWN child containers, not touch other devcontainers
// (including themselves).

const devcontainerIds = new Set<string>();

export function registerDevcontainer(name: string, id: string): void {
  devcontainerIds.add(name);
  if (id) {
    devcontainerIds.add(id);
    devcontainerIds.add(id.slice(0, 12));
  }
}

function isDevcontainer(target: string): boolean {
  return devcontainerIds.has(target);
}

// ── Policy ────────────────────────────────────────────────────────────────────

function checkPolicy(containerName: string): boolean {
  const grant = getGrant(containerName);
  return Boolean(grant && grant.until > Math.floor(Date.now() / 1000));
}

function lookupContainerId(containerName: string): Promise<{ id: string; shortId: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: `/containers/${encodeURIComponent(containerName)}/json`, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => {
          try {
            const id: string = JSON.parse(body).Id ?? '';
            resolve({ id, shortId: id.slice(0, 12) });
          } catch { resolve({ id: '', shortId: '' }); }
        });
      }
    );
    req.on('error', () => resolve({ id: '', shortId: '' }));
    req.end();
  });
}

function checkRequest(method: string, urlPath: string): boolean {
  const m = method.toUpperCase();
  const p = urlPath.replace(/^\/v[\d.]+/, '');

  // No destructive operations ever
  if (m === 'DELETE') return false;

  if (m === 'GET' || m === 'HEAD') {
    if (p === '/version' || p === '/info' || p === '/_ping') return true;
    if (p === '/containers/json' || p === '/containers/json') return true;
    if (p === '/images/json' || /^\/images\/[^/]+\/json$/.test(p)) return true;
    if (/^\/exec\/[^/]+\/json$/.test(p)) return true;
    if (/^\/containers\/[^/]+\/(json|logs|top)$/.test(p)) return true;
    return false;
  }

  if (m === 'POST') {
    // Exec session control — exec IDs are opaque UUIDs
    if (/^\/exec\/[^/]+\/(start|resize)$/.test(p)) return true;
    // Spawn new container
    if (p === '/containers/create') return true;
    // Container management — blocked for all devcontainers (own + others)
    const ct = p.match(/^\/containers\/([^/]+)\/(exec|start|stop|restart|kill|wait)$/)?.[1];
    if (ct) return !isDevcontainer(ct);
    return false;
  }

  return false;
}

// ── Per-container socket proxy ────────────────────────────────────────────────

export async function createContainerProxy(containerName: string, socketDir: string): Promise<net.Server> {
  const existing = proxyServers.get(containerName);
  if (existing) {
    existing.close();
    proxyServers.delete(containerName);
  }

  const { id, shortId } = await lookupContainerId(containerName);
  registerDevcontainer(containerName, id);

  const socketPath = path.join(socketDir, `${containerName}.sock`);
  try { fs.unlinkSync(socketPath); } catch {}

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      let upstream: net.Socket | null = null;
      let headerDone = false;
      let buf = Buffer.alloc(0);

      client.on('error', () => upstream?.destroy());
      client.on('end', () => upstream?.end());

      client.on('data', (chunk: Buffer) => {
        if (headerDone) {
          upstream?.write(chunk);
          return;
        }

        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;

        headerDone = true;
        const headerPart = buf.slice(0, end).toString();
        const afterHeaders = buf.slice(end);
        buf = Buffer.alloc(0);

        const firstLine = headerPart.split('\r\n')[0] ?? '';
        const [method = '', urlPath = ''] = firstLine.split(' ');

        if (!checkPolicy(containerName)) {
          console.log(`[socket-proxy] DENY ${containerName}: no active grant`);
          const body = '{"message":"authorization denied by policy"}';
          client.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
          client.end();
          return;
        }

        if (!checkRequest(method, urlPath)) {
          console.log(`[socket-proxy] DENY ${containerName}: ${method} ${urlPath} not allowed`);
          const body = '{"message":"operation not permitted"}';
          client.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
          client.end();
          return;
        }

        upstream = net.createConnection(DOCKER_SOCKET);
        upstream.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
            console.error(`[socket-proxy] upstream error for ${containerName}:`, err.message);
          }
          client.destroy();
        });
        upstream.on('end', () => client.end());
        upstream.pipe(client);
        upstream.write(headerPart + `\r\nX-Container-Id: ${containerName}` + afterHeaders.toString());
      });
    });

    server.on('error', reject);
    try { fs.mkdirSync(socketDir, { recursive: true }); } catch {}
    server.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o777); } catch {}
      console.log(`[socket-proxy] ${containerName} (${shortId || 'id-unknown'}) → ${socketPath}`);
      proxyServers.set(containerName, server);
      resolve(server);
    });
  });
}
