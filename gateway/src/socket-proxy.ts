import net from 'net';
import fs from 'fs';
import path from 'path';
import { getGrant } from './db';

const DOCKER_SOCKET = '/var/run/docker.sock';
const proxyServers = new Map<string, net.Server>();

// ── Policy ───────────────────────────────────────────────────────────────────
// Requires an active time-limited grant. Even with a grant:
// DELETE is always blocked; POST is restricted to exec/attach/logs (IDE attach).

function checkPolicy(containerName: string): boolean {
  const grant = getGrant(containerName);
  return Boolean(grant && grant.until > Math.floor(Date.now() / 1000));
}

function checkRequest(method: string, urlPath: string, containerName: string): boolean {
  const m = method.toUpperCase();
  const p = urlPath.replace(/^\/v[\d.]+/, '');

  // Never allow destructive operations
  if (m === 'DELETE') return false;

  if (m === 'GET' || m === 'HEAD') {
    if (p === '/version' || p === '/info' || p === '/_ping') return true;
    // Exec session inspection (exec IDs are UUIDs, can't restrict to own container)
    if (/^\/exec\/[^/]+\/json$/.test(p)) return true;
    // Container inspect/logs: any ID accepted (IntelliJ may use hash ID, not name)
    // but list-all (/containers/json) stays blocked
    if (/^\/containers\/[^/]+\/(json|logs|top)$/.test(p)) return true;
    return false;
  }

  if (m === 'POST') {
    // Exec start/resize: exec IDs are issued by Docker, can't scope to container here
    if (/^\/exec\/[^/]+\/(start|resize)$/.test(p)) return true;
    // Exec create: only on own container (by name OR by any ID — IntelliJ uses its container)
    // We allow any single container segment; the grant check already scopes the socket to one container
    if (/^\/containers\/[^/]+\/exec$/.test(p)) {
      // Extract the container identifier from the path and reject if it's clearly a different named container
      const match = p.match(/^\/containers\/([^/]+)\/exec$/);
      const target = match?.[1] ?? '';
      // Allow if target matches own name, or looks like a Docker ID (hex), or is short ID
      if (target === containerName || /^[a-f0-9]+$/i.test(target)) return true;
      return false;
    }
    return false;
  }
  return false;
}

// ── Per-container socket proxy ───────────────────────────────────────────────

export function createContainerProxy(containerName: string, socketDir: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const existing = proxyServers.get(containerName);
    if (existing) {
      existing.close();
      proxyServers.delete(containerName);
    }

    const socketPath = path.join(socketDir, `${containerName}.sock`);
    try { fs.unlinkSync(socketPath); } catch {}

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

        if (!checkRequest(method, urlPath, containerName)) {
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
      console.log(`[socket-proxy] ${containerName} → ${socketPath}`);
      proxyServers.set(containerName, server);
      resolve(server);
    });
  });
}
