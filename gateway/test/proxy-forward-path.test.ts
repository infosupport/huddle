import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Regressie op de finding #7-fix (#67) ─────────────────────────────────────
// De proxy BESLIST op de gedecodeerde vorm (normalizePathname), maar FORWARDT de
// originele encoded bytes. Werd de gedecodeerde vorm geforward, dan zag de
// upstream '/foo/a b' i.p.v. '/foo/a%20b' — en http.request gooide op de rauwe
// spatie synchroon ERR_UNESCAPED_CHARACTERS, wat vóór de 400-guard het hele
// gateway-proces neerhaalde. Deze suite pint het contract vast zónder Docker of
// een live container: een echte lokale upstream noteert de request-target die
// hij daadwerkelijk terugkrijgt.
//
// better-sqlite3 is een native module; in een DMZ-devcontainer zonder gebouwde
// binding slaan we de suite over (zie rules.test.ts). Probe vóór de db-import.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[proxy-forward-path.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;

let upstream: http.Server;
let upstreamPort = 0;
let lastUpstreamUrl: string | null = null;

let proxy: http.Server;
let proxyPort = 0;

// Stuur één request door de proxy als forward-proxy-client: over plain HTTP is
// de request-target absoluut (`GET http://host/pad`). Resolvet met de status die
// de CLIENT ziet — een antwoord bewijst dat de gateway nog leeft.
function proxyGet(pathAndQuery: string): Promise<number> {
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
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(!sqliteAvailable)('proxy forwards the original encoded request-path', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();

    // Geen Docker in de unit-omgeving: de client-IP hoeft niet naar een
    // container te resolven — een globale allow-regel volstaat.
    const dockerMod = await import('../src/docker');
    vi.spyOn(dockerMod, 'resolveContainerByIp').mockResolvedValue(null);

    upstream = http.createServer((req, res) => {
      lastUpstreamUrl = req.url ?? null;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    // createProxyServer bindt zelf (poort 0 = vrije efemere poort); wacht op
    // 'listening' i.p.v. zelf nog eens listen() aan te roepen.
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
    lastUpstreamUrl = null;
    // Host-only allow voor de upstream-host: matcht elk pad, zodat de test het
    // pad-forwardgedrag isoleert (niet de rule-matching).
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('127.0.0.1', NULL, 'allow')`).run();
  });

  it('%20 blijft encoded richting upstream (geen rauwe spatie, geen crash)', async () => {
    const status = await proxyGet('/foo/a%20b');
    expect(status).toBe(200);
    // Cruciaal: de encoded bytes, NIET de gedecodeerde '/foo/a b'.
    expect(lastUpstreamUrl).toBe('/foo/a%20b');
  });

  it('non-ASCII UTF-8 (%E2%9C%93) blijft encoded richting upstream', async () => {
    const status = await proxyGet('/foo/%E2%9C%93');
    expect(status).toBe(200);
    expect(lastUpstreamUrl).toBe('/foo/%E2%9C%93');
  });

  it('de query-string wordt behouden en niet gedecodeerd', async () => {
    const status = await proxyGet('/foo/bar?q=a%20b&x=1');
    expect(status).toBe(200);
    expect(lastUpstreamUrl).toBe('/foo/bar?q=a%20b&x=1');
  });

  it('traversal (%2f-getruceerd) wordt fail-closed geweigerd en nooit geforward', async () => {
    const status = await proxyGet('/foo/..%2f..%2fadmin');
    expect(status).toBe(403);
    expect(lastUpstreamUrl).toBeNull();
  });
});
