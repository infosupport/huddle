import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { forwardableHost } from './helpers/upstream-host';

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
// The proxy denies everything until a control plane is bound — it holds no
// policy of its own. createLocalPlane binds the real gateway client with the
// network stage removed, so a rule inserted below is only visible to the proxy
// after refresh(), exactly as it would be after a poll.
let control: import('./helpers/local-plane').LocalPlane;

// Niet 127.0.0.1: de proxy weigert alles wat aan Huddle zelf gericht is, en dat
// is het hele 127.0.0.0/8-blok (src/proxy-self.ts). Een upstream op loopback
// levert 403 op nog voordat er een regel bekeken wordt.
const upstreamHost = forwardableHost();

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
        path: `http://${upstreamHost}:${upstreamPort}${pathAndQuery}`,
        headers: { host: `${upstreamHost}:${upstreamPort}` },
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

describe.skipIf(!sqliteAvailable || !upstreamHost)('proxy forwards the original encoded request-path', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();

    // Geen Docker in de unit-omgeving: de client-IP hoeft niet naar een
    // container te resolven — een globale allow-regel volstaat.
    const { createLocalPlane } = await import('./helpers/local-plane');
    const { setControlPlane } = await import('../src/control/plane');
    control = await createLocalPlane();
    setControlPlane(control.plane);

    upstream = http.createServer((req, res) => {
      lastUpstreamUrl = req.url ?? null;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => upstream.listen(0, upstreamHost!, () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    // createProxyServer bindt zelf (poort 0 = vrije efemere poort); wacht op
    // 'listening' i.p.v. zelf nog eens listen() aan te roepen.
    const { createProxyServer } = await import('../src/proxy');
    proxy = createProxyServer(0);
    await new Promise<void>((r) => proxy.once('listening', () => r()));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const { resetControlPlane } = await import('../src/control/plane');
    resetControlPlane();
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  });

  beforeEach(async () => {
    db.exec('DELETE FROM rules');
    lastUpstreamUrl = null;
    // Host-only allow voor de upstream-host: matcht elk pad, zodat de test het
    // pad-forwardgedrag isoleert (niet de rule-matching).
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, NULL, 'allow')`).run(upstreamHost);
    await control.refresh();
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
