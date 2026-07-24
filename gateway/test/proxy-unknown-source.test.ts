import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Default-deny voor onbekende proxy-bronnen ────────────────────────────────
// De egress-proxy identificeert clients op bron-IP → containermap (kinderen
// erven hun parent-devcontainer). Sinds de port-relay de gateway aan workload-
// netwerken koppelt, kan de proxy in principe bereikt worden door bronnen die
// niet naar een huddle-beheerde container herleiden. Die mochten voorheen
// stilletjes meeliften op GLOBALE allow-regels (en vervuilden de rules-tabel
// met requested-regels) — een bypass van "no direct internet". Deze suite pint
// het nieuwe contract vast:
//   1. onbekende bron → 403, óók met een matchende globale allow-regel;
//   2. onbekende bron maakt géén requested-regel aan;
//   3. een bekende container blijft de globale-regel-fallback houden.
//
// better-sqlite3 is een native module; zonder bruikbare binding slaan we over
// (zelfde probe als proxy-forward-path.test.ts).
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[proxy-unknown-source.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`
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

describe.skipIf(!sqliteAvailable)('proxy default-deny voor onbekende bronnen', () => {
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
    // Globale allow voor de upstream-host: de verleiding waar een onbekende
    // bron vroeger op meeliftte.
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('127.0.0.1', NULL, 'allow')`).run();
  });

  it('onbekende bron → 403, ondanks een matchende globale allow-regel', async () => {
    resolveMock.mockResolvedValue(null);
    const { status, blockedHeader } = await proxyGet('/data');
    expect(status).toBe(403);
    expect(blockedHeader).toBe('1');
  });

  it('onbekende bron maakt géén requested-regel aan (geen rules-vervuiling)', async () => {
    resolveMock.mockResolvedValue(null);
    db.exec('DELETE FROM rules'); // ook geen globale regel: het no-match-pad
    await proxyGet('/data');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('bekende container houdt de globale-regel-fallback (regressieguard)', async () => {
    resolveMock.mockResolvedValue('dc-known');
    const { status } = await proxyGet('/data');
    expect(status).toBe(200);
  });
});
