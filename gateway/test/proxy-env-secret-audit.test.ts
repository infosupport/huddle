import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import zlib from 'zlib';
import type { AddressInfo } from 'net';

// ── Env-mapping secrets never reach audit_log (#108) ─────────────────────────
//
// The proxy redeems a placeholder into the real secret on the way upstream. The
// feature's promise is that the audit trail only ever shows the placeholder —
// but the audit trail also stores the upstream's response, and an allowlisted
// service is free to echo request headers back (a debug endpoint, a Set-Cookie,
// an error naming the credential). Without redaction that response lands in
// SQLite and is served straight back out of /api/audit.
//
// This drives the real proxy against a real upstream that deliberately echoes
// the Authorization header in both the response headers and the body.

// host-config reads HOME_DIR at module load, so the config file has to exist and
// be pointed at BEFORE anything imports it (env-mappings → host-config).
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-home-'));
process.env.HUDDLE_HOME_DIR = HOME_DIR;

const MAPPING_ID = 1;
const SECRET = 'sk-real-secret-value-do-not-log';
const CONTAINER = 'devcontainer-envtest';

fs.writeFileSync(
  path.join(HOME_DIR, 'config.json'),
  JSON.stringify({
    envMappings: [{
      id: MAPPING_ID,
      name: 'Test token',
      varName: 'TEST_TOKEN',
      value: '',
      secret: true,
      secretHosts: '127.0.0.1',
      global: false,
      enabled: true,
      sortOrder: 0,
    }],
  }),
);

let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[proxy-env-secret-audit.test] SKIPPED — better-sqlite3 not usable: ${(e as Error).message}`);
}

let db: typeof import('../src/db').db;
let placeholder: string;

let upstream: http.Server;
let upstreamPort = 0;
let lastUpstreamAuth: string | null = null;

let proxy: http.Server;
let proxyPort = 0;

interface ClientResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

function proxyGet(path = '/echo'): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://127.0.0.1:${upstreamPort}${path}`,
        headers: { host: `127.0.0.1:${upstreamPort}`, authorization: `Bearer ${placeholder}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// complete() runs on the upstream's 'end', which can land a tick after the
// client sees its own 'end' — poll briefly instead of racing it.
async function auditRow(): Promise<{ req_headers: string; res_headers: string; res_body: string }> {
  for (let i = 0; i < 50; i++) {
    const row = db
      .prepare('SELECT req_headers, res_headers, res_body FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { req_headers: string; res_headers: string; res_body: string } | undefined;
    if (row?.res_body) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no completed audit row');
}

describe.skipIf(!sqliteAvailable)('env-mapping secrets stay out of the audit log', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();

    const { newEnvPlaceholder } = await import('../src/env-mappings');
    placeholder = newEnvPlaceholder();
    dbMod.setEnvSecret(MAPPING_ID, SECRET);
    dbMod.setContainerEnvMappings(CONTAINER, [{ mapping_id: MAPPING_ID, placeholder }]);

    // No Docker here: pin the client IP to the container that owns the
    // placeholder, otherwise substitution correctly refuses to redeem it.
    const dockerMod = await import('../src/docker');
    vi.spyOn(dockerMod, 'resolveContainerByIp').mockResolvedValue(CONTAINER);

    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('127.0.0.1', NULL, 'allow')`).run();

    // The hostile-but-legitimate upstream: it reflects what it was sent. `/gzip`
    // does the same through a compressed body, `/stream` through SSE.
    upstream = http.createServer((req, res) => {
      lastUpstreamAuth = (req.headers.authorization as string) ?? null;
      const echo = JSON.stringify({ youSent: { authorization: lastUpstreamAuth } });
      if (req.url === '/gzip') {
        const gz = zlib.gzipSync(Buffer.from(echo, 'utf8'));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(gz.length) });
        res.end(gz);
        return;
      }
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // Split the secret across two writes, so a per-chunk replace would miss it.
        const half = Math.floor((lastUpstreamAuth ?? '').length / 2);
        res.write(`data: ${(lastUpstreamAuth ?? '').slice(0, half)}`);
        res.write(`${(lastUpstreamAuth ?? '').slice(half)}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-echo-authorization': lastUpstreamAuth ?? '',
      });
      res.end(echo);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const { createProxyServer } = await import('../src/proxy');
    proxy = createProxyServer(0);
    await new Promise<void>((r) => proxy.once('listening', () => r()));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    fs.rmSync(HOME_DIR, { recursive: true, force: true });
  });

  it('redeems the placeholder upstream but audits only the placeholder', async () => {
    const res = await proxyGet();
    expect(res.status).toBe(200);

    // The point of the feature: the upstream really did get the secret.
    expect(lastUpstreamAuth).toBe(`Bearer ${SECRET}`);

    const row = await auditRow();
    // Request headers were already safe (substitution runs on a copy)...
    expect(row.req_headers).toContain(placeholder);
    expect(row.req_headers).not.toContain(SECRET);
    // ...and so is everything the upstream echoed back at us.
    expect(row.res_headers).not.toContain(SECRET);
    expect(row.res_headers).toContain(placeholder);
    expect(row.res_body).not.toContain(SECRET);
    expect(row.res_body).toContain(placeholder);
  });

  // The audit log is not the only copy: what the DEVCONTAINER receives must not
  // carry the secret either, or the placeholder design is defeated outright.
  it('never hands the echoed secret back to the container', async () => {
    const res = await proxyGet();
    expect(res.status).toBe(200);
    expect(lastUpstreamAuth).toBe(`Bearer ${SECRET}`);

    expect(res.body).not.toContain(SECRET);
    expect(res.body).toContain(placeholder);
    expect(res.headers['x-echo-authorization']).not.toContain(SECRET);
    expect(res.headers['x-echo-authorization']).toContain(placeholder);
  });

  it('redacts a compressed body too, relaying it decompressed', async () => {
    const res = await proxyGet('/gzip');
    expect(res.status).toBe(200);
    // The secret is invisible in gzip bytes, so the body has to be inflated,
    // rewritten and sent on identity-encoded.
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).not.toContain(SECRET);
    expect(res.body).toContain(placeholder);
  });

  it('redacts a secret split across SSE writes without buffering the stream', async () => {
    const res = await proxyGet('/stream');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).not.toContain(SECRET);
    expect(res.body).toContain(placeholder);
    expect(res.body).toContain('[DONE]');
  });
});
