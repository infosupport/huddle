import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Default-deny for unknown proxy sources ───────────────────────────────────
// The egress proxy identifies clients via source-IP → container mapping
// (children inherit their parent devcontainer). Since the port relay attaches
// the gateway to workload networks, the proxy can in principle be reached by
// sources that do not resolve to a huddle-managed container. Those could
// previously piggyback silently on GLOBAL allow rules (and polluted the rules
// table with requested rules) — a bypass of "no direct internet". This suite
// pins down the new contract:
//   1. unknown source → 403, even with a matching global allow rule;
//   2. an unknown source creates no requested rule;
//   3. a known container keeps the global-rule fallback.
//
// better-sqlite3 is a native module; without a usable binding we skip
// (same probe as proxy-forward-path.test.ts).
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[proxy-unknown-source.test] SKIPPED — better-sqlite3 binding not usable: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;
let resolveMock: ReturnType<typeof vi.spyOn>;

let upstream: http.Server;
let upstreamPort = 0;

let proxy: http.Server;
let proxyPort = 0;

function proxyGet(pathAndQuery: string): Promise<{ status: number; blockedHeader: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://127.0.0.1:${upstreamPort}${pathAndQuery}`,
        headers: { host: `127.0.0.1:${upstreamPort}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          blockedHeader: res.headers['x-huddle-blocked'] as string | undefined,
        }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(!sqliteAvailable)('proxy default-deny for unknown sources', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();

    const dockerMod = await import('../src/docker');
    resolveMock = vi.spyOn(dockerMod, 'resolveContainerByIp') as any;

    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
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
  });

  beforeEach(() => {
    db.exec('DELETE FROM rules');
    db.exec('DELETE FROM audit_log');
    // Global allow for the upstream host: the temptation an unknown source
    // used to piggyback on.
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('127.0.0.1', NULL, 'allow')`).run();
  });

  it('unknown source → 403, despite a matching global allow rule', async () => {
    resolveMock.mockResolvedValue(null);
    const { status, blockedHeader } = await proxyGet('/data');
    expect(status).toBe(403);
    expect(blockedHeader).toBe('1');
  });

  it('unknown source creates no requested rule (no rules pollution)', async () => {
    resolveMock.mockResolvedValue(null);
    db.exec('DELETE FROM rules'); // no global rule either: the no-match path
    await proxyGet('/data');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('known container keeps the global-rule fallback (regression guard)', async () => {
    resolveMock.mockResolvedValue('dc-known');
    const { status } = await proxyGet('/data');
    expect(status).toBe(200);
  });
});
