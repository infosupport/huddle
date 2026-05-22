import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { getGrant } from './db';

const DOCKER_SOCKET = '/var/run/docker.sock';
const proxyServers = new Map<string, net.Server>();

// ── Policy ───────────────────────────────────────────────────────────────────

function checkPolicy(containerName: string): boolean {
  const grant = getGrant(containerName);
  return Boolean(grant && grant.until > Math.floor(Date.now() / 1000));
}

// Fetch the container's full and short Docker ID so we can match by ID too.
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

// Returns true if `target` (from URL path) refers to this container.
function isOwn(target: string, name: string, id: string, shortId: string): boolean {
  return target === name || (id !== '' && target === id) || (shortId !== '' && target === shortId);
}

function checkRequest(
  method: string,
  urlPath: string,
  name: string,
  id: string,
  shortId: string,
): boolean {
  const m = method.toUpperCase();
  const p = urlPath.replace(/^\/v[\d.]+/, '');

  if (m === 'DELETE') return false;

  if (m === 'GET' || m === 'HEAD') {
    if (p === '/version' || p === '/info' || p === '/_ping') return true;
    // Exec inspection — exec IDs are UUIDs; can't scope them further
    if (/^\/exec\/[^/]+\/json$/.test(p)) return true;
    // Container inspect/logs: only own container
    const ct = p.match(/^\/containers\/([^/]+)\/(json|logs|top)$/)?.[1];
    if (ct && isOwn(ct, name, id, shortId)) return true;
    return false;
  }

  if (m === 'POST') {
    // Exec start/resize: exec IDs are opaque UUIDs issued by Docker
    if (/^\/exec\/[^/]+\/(start|resize)$/.test(p)) return true;
    // Exec create: only own container
    const ct = p.match(/^\/containers\/([^/]+)\/exec$/)?.[1];
    if (ct && isOwn(ct, name, id, shortId)) return true;
    return false;
  }

  return false;
}

// ── Per-container socket proxy ───────────────────────────────────────────────

export async function createContainerProxy(containerName: string, socketDir: string): Promise<net.Server> {
  const existing = proxyServers.get(containerName);
  if (existing) {
    existing.close();
    proxyServers.delete(containerName);
  }

  const { id, shortId } = await lookupContainerId(containerName);

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

        if (!checkRequest(method, urlPath, containerName, id, shortId)) {
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
