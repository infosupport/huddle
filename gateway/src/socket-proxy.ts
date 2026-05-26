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

// Reject HostConfig shapes that would let a spawned container escape the
// devcontainer sandbox (read host fs, see host PIDs, talk to host dockerd).
// Returns a denial reason, or null if the config is safe.
function validateHostConfig(hostConfig: any): string | null {
  if (!hostConfig || typeof hostConfig !== 'object') return null;

  if (hostConfig.Privileged === true) return 'Privileged containers not permitted';
  if (hostConfig.PidMode && hostConfig.PidMode !== '') return 'PidMode not permitted';
  if (hostConfig.IpcMode === 'host') return 'IpcMode=host not permitted';
  if (hostConfig.UsernsMode === 'host') return 'UsernsMode=host not permitted';
  if (hostConfig.CgroupnsMode === 'host') return 'CgroupnsMode=host not permitted';
  if (hostConfig.UTSMode === 'host') return 'UTSMode=host not permitted';
  if (hostConfig.CgroupParent) return 'CgroupParent override not permitted';

  if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0)
    return 'CapAdd not permitted';
  if (Array.isArray(hostConfig.Devices) && hostConfig.Devices.length > 0)
    return 'Devices not permitted';

  const sys = hostConfig.Sysctls;
  if (sys && typeof sys === 'object' && Object.keys(sys).length > 0)
    return 'Sysctls not permitted';

  if (Array.isArray(hostConfig.SecurityOpt)) {
    for (const opt of hostConfig.SecurityOpt) {
      if (typeof opt !== 'string') continue;
      const norm = opt.toLowerCase().replace(/\s+/g, '');
      if (norm === 'apparmor=unconfined' ||
          norm === 'seccomp=unconfined' ||
          norm === 'label=disable' ||
          norm === 'systempaths=unconfined' ||
          norm === 'no-new-privileges=false')
        return `SecurityOpt ${opt} not permitted`;
    }
  }

  // Bind mounts from the host fs are the main escape vector
  // (`-v /:/host`, `-v /var/run/docker.sock:/var/run/docker.sock`).
  // Source paths starting with `/` are host paths; anything else is a named volume.
  if (Array.isArray(hostConfig.Binds)) {
    for (const bind of hostConfig.Binds) {
      if (typeof bind !== 'string') continue;
      const src = bind.split(':')[0] ?? '';
      if (src.startsWith('/')) return `host-path bind not permitted: ${bind}`;
    }
  }

  if (Array.isArray(hostConfig.Mounts)) {
    for (const mount of hostConfig.Mounts) {
      if (mount && mount.Type === 'bind') return 'bind-type mounts not permitted';
    }
  }

  return null;
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

        // Force Connection: close so docker CLI cannot reuse this TCP socket
        // for a second request — every request must reopen and re-enter our
        // header parser (otherwise we'd tunnel subsequent requests raw and
        // bypass /containers/json filtering).
        const sep = firstData.indexOf('\r\n\r\n');
        if (sep === -1) { upstream.write(firstData); return; }
        const headerStr = firstData.slice(0, sep).toString();
        const tail = firstData.slice(sep + 4);
        const lines = headerStr.split('\r\n');
        const fixed = [
          lines[0],
          'Connection: close',
          ...lines.slice(1).filter(l => !/^connection:\s*/i.test(l)),
        ].join('\r\n');
        upstream.write(Buffer.concat([Buffer.from(fixed + '\r\n\r\n'), tail]));
      }

      function forwardWithRewrittenUrl(headerPart: string, newUrl: string, remainder: Buffer): void {
        const newHeader = rewriteFirstLine(headerPart, newUrl) + '\r\n\r\n';
        openUpstream(Buffer.concat([Buffer.from(newHeader), remainder]));
      }

      function processInjectedBody(): void {
        const bodyBytes = bodyBuf.slice(0, bodyContentLength);
        const rest = bodyBuf.slice(bodyContentLength);
        let body: any;
        try {
          body = JSON.parse(bodyBytes.toString());
        } catch {
          // Unparseable body must not bypass HostConfig validation.
          deny403(client, 'invalid container create body');
          return;
        }
        const denial = validateHostConfig(body.HostConfig);
        if (denial) { deny403(client, denial); return; }
        body.Labels = { ...(body.Labels ?? {}), 'huddle.parent': containerName };
        // Force spawned containers onto the parent devcontainer's network only.
        body.HostConfig = { ...(body.HostConfig ?? {}), NetworkMode: `dc-net-${containerName}` };
        delete body.NetworkingConfig;
        const newBodyBuf = Buffer.from(JSON.stringify(body));
        const newHeader = savedHeaderPart.replace(
          /content-length:\s*\d+/i,
          `Content-Length: ${newBodyBuf.length}`
        ) + '\r\n\r\n';
        openUpstream(Buffer.concat([Buffer.from(newHeader), newBodyBuf, rest]));
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
              /^\/images\/[^/]+\/json$/.test(p)) {
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
          // Inspect / logs / top — only on containers labeled by this devcontainer
          const inspectCt = p.match(/^\/containers\/([^/]+)\/(json|logs|top)$/)?.[1];
          if (inspectCt) {
            if (devcontainerIds.has(inspectCt)) {
              deny403(client, 'inspect of devcontainer not permitted');
              return;
            }
            client.pause();
            hasOwnLabel('container', inspectCt, containerName).then(ok => {
              if (ok) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              } else {
                deny403(client, 'container not owned by this devcontainer');
              }
              client.resume();
            });
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
