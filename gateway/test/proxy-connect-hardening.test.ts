import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';

// ── Egress proxy: CONNECT / identity hardening ───────────────────────────────
// - An out-of-range CONNECT port made net.connect throw synchronously inside the
//   async listener, which took down the whole shared gateway process.
// - A raw (non-443) CONNECT tunnel to a path-mode domain skipped every path rule.
// - X-Huddle-Ext must never be forwarded upstream.
// Same harness as proxy-forward-path.test.ts: a real local upstream, no Docker.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[proxy-connect-hardening.test] SKIPPED — better-sqlite3 binding not usable: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;

let upstream: http.Server;
let upstreamPort = 0;
let lastUpstreamHeaders: http.IncomingHttpHeaders | null = null;

// Plain TCP target for the raw-tunnel tests; its sockets are tracked so the
// tunnel can be torn down in afterAll.
let rawTarget: net.Server;
let rawTargetPort = 0;
const rawSockets = new Set<net.Socket>();

let proxy: http.Server;
let proxyPort = 0;

function proxyGet(pathAndQuery: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://127.0.0.1:${upstreamPort}${pathAndQuery}`,
        headers: { host: `127.0.0.1:${upstreamPort}`, ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Send a raw CONNECT and resolve with the status line the client gets back.
function connectStatus(authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      const eol = buf.indexOf('\r\n');
      if (eol !== -1) { s.destroy(); resolve(buf.slice(0, eol)); }
    });
    s.on('error', reject);
    s.on('close', () => resolve(buf.split('\r\n')[0]));
  });
}

describe.skipIf(!sqliteAvailable)('egress proxy CONNECT / identity hardening', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();

    const dockerMod = await import('../src/docker');
    vi.spyOn(dockerMod, 'resolveContainerByIp').mockResolvedValue(null);

    upstream = http.createServer((req, res) => {
      lastUpstreamHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    rawTarget = net.createServer((sock) => {
      rawSockets.add(sock);
      sock.on('close', () => rawSockets.delete(sock));
    });
    await new Promise<void>((r) => rawTarget.listen(0, '127.0.0.1', () => r()));
    rawTargetPort = (rawTarget.address() as AddressInfo).port;

    const { createProxyServer } = await import('../src/proxy');
    proxy = createProxyServer(0);
    await new Promise<void>((r) => proxy.once('listening', () => r()));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const sock of rawSockets) sock.destroy();
    await new Promise<void>((r) => (rawTarget ? rawTarget.close(() => r()) : r()));
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  });

  beforeEach(() => {
    db.exec('DELETE FROM rules');
    lastUpstreamHeaders = null;
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('127.0.0.1', NULL, 'allow')`).run();
  });

  it('rejects out-of-range or non-integer CONNECT ports with 400 and stays up', async () => {
    for (const port of ['65536', '0', '-1', '1.5', '99999', '']) {
      expect(await connectStatus(`127.0.0.1:${port}`)).toMatch(/^HTTP\/1\.1 400/);
    }
    // The gateway process is still serving.
    expect(await proxyGet('/alive')).toBe(200);
  });

  it('opens a raw tunnel to a non-443 port of a host-allowed domain', async () => {
    expect(await connectStatus(`127.0.0.1:${rawTargetPort}`)).toMatch(/^HTTP\/1\.1 200/);
  });

  it('refuses a raw tunnel to a path-mode domain (path rules would be skipped)', async () => {
    db.exec(`UPDATE rules SET path_mode = 1 WHERE domain = '127.0.0.1'`);
    expect(await connectStatus(`127.0.0.1:${rawTargetPort}`)).toMatch(/^HTTP\/1\.1 403/);
  });

  it('keeps the path-mode tunnel closed when TLS inspection is off (paths cannot be seen)', async () => {
    db.exec(`UPDATE rules SET status = 'deny', path_mode = 1 WHERE domain = '127.0.0.1'`);
    expect(await connectStatus('127.0.0.1:443')).toMatch(/^HTTP\/1\.1 200/); // inspected: admitted
    db.exec(`UPDATE rules SET no_intercept = 1 WHERE domain = '127.0.0.1'`);
    expect(await connectStatus('127.0.0.1:443')).toMatch(/^HTTP\/1\.1 403/);
  });

  it('does not forward X-Huddle-Ext upstream', async () => {
    expect(await proxyGet('/x', { 'x-huddle-ext': 'some-ext' })).toBe(200);
    expect(lastUpstreamHeaders?.['x-huddle-ext']).toBeUndefined();
  });
});
