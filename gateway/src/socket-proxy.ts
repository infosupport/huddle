import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { getGrant } from './db';

const DOCKER_SOCKET = '/var/run/docker.sock';
const proxyServers = new Map<string, net.Server>();

// ── Devcontainer registry ─────────────────────────────────────────────────────

const devcontainerIds = new Set<string>();

export function registerDevcontainer(name: string, id: string): void {
  devcontainerIds.add(name);
  if (id) { devcontainerIds.add(id); devcontainerIds.add(id.slice(0, 12)); }
}

// ── Docker helpers ────────────────────────────────────────────────────────────

function dockerGet(urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: urlPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('parse')); } });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function hasOwnLabel(type: 'container' | 'image', targetId: string, containerName: string): Promise<boolean> {
  try {
    const urlPath = type === 'container'
      ? `/containers/${encodeURIComponent(targetId)}/json`
      : `/images/${encodeURIComponent(targetId)}/json`;
    const data = await dockerGet(urlPath);
    const labels: Record<string, string> = data.Config?.Labels ?? {};
    return labels['huddle.parent'] === containerName;
  } catch { return false; }
}

function lookupContainerId(containerName: string): Promise<{ id: string; shortId: string }> {
  return dockerGet(`/containers/${encodeURIComponent(containerName)}/json`)
    .then(data => { const id: string = data.Id ?? ''; return { id, shortId: id.slice(0, 12) }; })
    .catch(() => ({ id: '', shortId: '' }));
}

// Add/merge a label filter into a Docker API query string.
function withLabelFilter(rawUrl: string, label: string): string {
  const qi = rawUrl.indexOf('?');
  const base = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
  const params = new URLSearchParams(qi === -1 ? '' : rawUrl.slice(qi + 1));
  let filters: Record<string, string[]> = {};
  try { filters = JSON.parse(params.get('filters') ?? '{}'); } catch {}
  filters.label = [...(filters.label ?? []), label];
  params.set('filters', JSON.stringify(filters));
  return `${base}?${params.toString()}`;
}

function rewriteFirstLine(headerPart: string, newUrl: string): string {
  const lines = headerPart.split('\r\n');
  const parts = (lines[0] ?? '').split(' ');
  lines[0] = `${parts[0]} ${newUrl} ${parts[2]}`;
  return lines.join('\r\n');
}

// ── Policy ────────────────────────────────────────────────────────────────────

function checkPolicy(containerName: string): boolean {
  const grant = getGrant(containerName);
  return Boolean(grant && grant.until > Math.floor(Date.now() / 1000));
}

function deny403(client: net.Socket, msg: string): void {
  const body = JSON.stringify({ message: msg });
  client.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  client.end();
}

// ── Per-container socket proxy ────────────────────────────────────────────────

export async function createContainerProxy(containerName: string, socketDir: string): Promise<net.Server> {
  const existing = proxyServers.get(containerName);
  if (existing) { existing.close(); proxyServers.delete(containerName); }

  const { id, shortId } = await lookupContainerId(containerName);
  registerDevcontainer(containerName, id);

  const socketPath = path.join(socketDir, `${containerName}.sock`);
  try { fs.unlinkSync(socketPath); } catch {}

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      let upstream: net.Socket | null = null;
      let phase: 'headers' | 'body' | 'tunnel' = 'headers';
      let headerBuf = Buffer.alloc(0);

      // Body-accumulation state (for POST /containers/create)
      let bodyBuf = Buffer.alloc(0);
      let bodyContentLength = 0;
      let savedHeaderPart = '';

      client.on('error', () => upstream?.destroy());
      client.on('end', () => upstream?.end());

      function openUpstream(firstData: Buffer): void {
        phase = 'tunnel';
        upstream = net.createConnection(DOCKER_SOCKET);
        upstream.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET')
            console.error(`[socket-proxy] upstream error for ${containerName}:`, err.message);
          client.destroy();
        });
        upstream.on('end', () => client.end());
        upstream.pipe(client);
        upstream.write(firstData);
      }

      function forwardWithRewrittenUrl(headerPart: string, newUrl: string, remainder: Buffer): void {
        const newHeader = rewriteFirstLine(headerPart, newUrl) + '\r\n\r\n';
        openUpstream(Buffer.concat([Buffer.from(newHeader), remainder]));
      }

      function processInjectedBody(): void {
        const bodyBytes = bodyBuf.slice(0, bodyContentLength);
        const rest = bodyBuf.slice(bodyContentLength);
        try {
          const body = JSON.parse(bodyBytes.toString());
          body.Labels = { ...(body.Labels ?? {}), 'huddle.parent': containerName };
          const newBodyBuf = Buffer.from(JSON.stringify(body));
          const newHeader = savedHeaderPart.replace(
            /content-length:\s*\d+/i,
            `Content-Length: ${newBodyBuf.length}`
          ) + '\r\n\r\n';
          openUpstream(Buffer.concat([Buffer.from(newHeader), newBodyBuf, rest]));
        } catch {
          openUpstream(Buffer.concat([Buffer.from(savedHeaderPart + '\r\n\r\n'), bodyBuf]));
        }
      }

      client.on('data', (chunk: Buffer) => {
        if (phase === 'tunnel') { upstream?.write(chunk); return; }

        if (phase === 'body') {
          bodyBuf = Buffer.concat([bodyBuf, chunk]);
          if (bodyBuf.length >= bodyContentLength) processInjectedBody();
          return;
        }

        // ── Header accumulation ──────────────────────────────────────────────
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const end = headerBuf.indexOf('\r\n\r\n');
        if (end === -1) return;

        const headerPart = headerBuf.slice(0, end).toString();
        const remainder = headerBuf.slice(end + 4);
        headerBuf = Buffer.alloc(0);

        const firstLine = headerPart.split('\r\n')[0] ?? '';
        const parts = firstLine.split(' ');
        const method = (parts[0] ?? '').toUpperCase();
        const rawUrl = parts[1] ?? '';
        const p = rawUrl.replace(/^\/v[\d.]+/, '').split('?')[0];

        if (!checkPolicy(containerName)) {
          deny403(client, 'authorization denied by policy');
          return;
        }

        // ── DELETE ───────────────────────────────────────────────────────────
        if (method === 'DELETE') {
          const ctId = p.match(/^\/containers\/([^/]+)$/)?.[1];
          const imgId = p.match(/^\/images\/([^/]+)$/)?.[1];
          const targetId = ctId ?? imgId;
          const type = ctId ? 'container' : 'image';

          if (!targetId) { deny403(client, 'delete not permitted'); return; }

          client.pause();
          hasOwnLabel(type, targetId, containerName).then(ok => {
            if (ok) {
              openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            } else {
              deny403(client, `cannot delete ${type} not created by this container`);
            }
            client.resume();
          });
          return;
        }

        // ── GET / HEAD ───────────────────────────────────────────────────────
        if (method === 'GET' || method === 'HEAD') {
          if (p === '/version' || p === '/info' || p === '/_ping' ||
              /^\/exec\/[^/]+\/json$/.test(p) ||
              /^\/images\/[^/]+\/json$/.test(p) ||
              /^\/containers\/[^/]+\/(json|logs|top)$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }
          if (p === '/images/json') {
            // Show all images — agent needs to know available base images
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }
          if (p === '/containers/json') {
            // Filter to own containers only
            forwardWithRewrittenUrl(headerPart, withLabelFilter(rawUrl, `huddle.parent=${containerName}`), remainder);
            return;
          }
          deny403(client, 'path not allowed');
          return;
        }

        // ── POST ─────────────────────────────────────────────────────────────
        if (method === 'POST') {
          // Exec session control (exec IDs are opaque)
          if (/^\/exec\/[^/]+\/(start|resize)$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Spawn container — inject huddle.parent label
          if (p === '/containers/create') {
            const clMatch = headerPart.match(/content-length:\s*(\d+)/i);
            bodyContentLength = clMatch ? parseInt(clMatch[1]) : 0;
            savedHeaderPart = headerPart;
            phase = 'body';
            bodyBuf = remainder;
            if (bodyBuf.length >= bodyContentLength) processInjectedBody();
            return;
          }

          // Docker build — add huddle.parent label via query param
          if (p === '/build') {
            const labelParam = encodeURIComponent(JSON.stringify({ 'huddle.parent': containerName }));
            const newUrl = rawUrl.includes('?') ? `${rawUrl}&labels=${labelParam}` : `${rawUrl}?labels=${labelParam}`;
            forwardWithRewrittenUrl(headerPart, newUrl, remainder);
            return;
          }

          // Pull image — allow (no labeling possible, agent may need base images)
          if (p === '/images/create') {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Container management: only for own spawned containers, never devcontainers
          const ctId = p.match(/^\/containers\/([^/]+)\/(exec|start|stop|restart|kill|wait)$/)?.[1];
          if (ctId) {
            if (devcontainerIds.has(ctId)) {
              deny403(client, 'operation on devcontainer not permitted');
              return;
            }
            client.pause();
            hasOwnLabel('container', ctId, containerName).then(ok => {
              if (ok) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              } else {
                deny403(client, 'container was not created by this devcontainer');
              }
              client.resume();
            });
            return;
          }

          deny403(client, 'operation not permitted');
          return;
        }

        deny403(client, 'method not allowed');
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
