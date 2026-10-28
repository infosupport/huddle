import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';

// De sbx-egress-listener (docs/host-pipe.md, "sbx egress"): de sbx-daemon stuurt
// Proxy-Authorization met het secret van de sandbox. Bekend secret → door de
// firewall als `sbx:<naam>`; onbekend of het reset-secret → 407. Echte DB, echte
// proxy, lokale upstreams; geen Docker.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[proxy-sbx.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`);
}

let dbMod: typeof import('../src/db');
let store: typeof import('../src/environments/sbx-store').dbSbxStore;
let hashProxySecret: typeof import('../src/environments/sbx-egress').hashProxySecret;
let upstream: http.Server;
let upstreamPort = 0;
let upstreamSaw: http.IncomingHttpHeaders | null = null;
let tcp: net.Server;
let tcpPort = 0;
const tcpSockets = new Set<net.Socket>();
let proxy: http.Server;
let proxyPort = 0;
let resets = 0;

const SECRET = 'A'.repeat(43);
const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

function proxyGet(auth?: string, host = `127.0.0.1:${upstreamPort}`): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://${host}/x`,
        headers: { host, ...(auth ? { 'proxy-authorization': auth } : {}) },
      },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); },
    );
    req.on('error', reject);
    req.end();
  });
}

// CONNECT naar de TCP-echo; geeft de statusregel en (bij 200) wat de echo terugstuurt.
function proxyConnect(auth?: string): Promise<{ statusLine: string; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`CONNECT 127.0.0.1:${tcpPort} HTTP/1.1\r\nhost: 127.0.0.1:${tcpPort}\r\n${auth ? `proxy-authorization: ${auth}\r\n` : ''}\r\n`);
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const statusLine = buf.split('\r\n')[0];
      if (!statusLine.includes(' 200 ')) { s.destroy(); resolve({ statusLine }); return; }
      const rest = buf.slice(end + 4);
      if (rest.includes('ping')) { s.destroy(); resolve({ statusLine, echoed: rest }); return; }
      if (!rest) s.write('ping');
    });
    s.on('error', reject);
  });
}

describe.skipIf(!sqliteAvailable)('sbx egress listener', () => {
  beforeAll(async () => {
    dbMod = await import('../src/db');
    dbMod.initDb();
    ({ dbSbxStore: store } = await import('../src/environments/sbx-store'));
    ({ hashProxySecret } = await import('../src/environments/sbx-egress'));
    const dockerMod = await import('../src/docker');
    vi.spyOn(dockerMod, 'resolveContainerByIp').mockResolvedValue('should-not-be-used');

    upstream = http.createServer((req, res) => { upstreamSaw = req.headers; res.end('ok'); });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
    tcp = net.createServer((sock) => { tcpSockets.add(sock); sock.pipe(sock); });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    tcpPort = (tcp.address() as AddressInfo).port;

    const { createProxyServer } = await import('../src/proxy');
    const { sbxEgressIdentify } = await import('../src/environments/sbx-store');
    proxy = createProxyServer(0, { intercept: false, identify: sbxEgressIdentify(() => { resets++; }) });
    await new Promise<void>((r) => proxy.once('listening', () => r()));
    proxyPort = (proxy.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    // Keep-alive-verbindingen en tunnels houden close() anders open.
    proxy?.closeAllConnections();
    upstream?.closeAllConnections();
    for (const sock of tcpSockets) sock.destroy();
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    await new Promise<void>((r) => (tcp ? tcp.close(() => r()) : r()));
  });

  beforeEach(() => {
    dbMod.db.exec('DELETE FROM rules; DELETE FROM sandboxes; DELETE FROM audit_log');
    dbMod.db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('127.0.0.1', NULL, 'allow')`).run();
    store.setEnabled(true);
    store.saveIdentity('box', hashProxySecret(SECRET), { name: 'box', agent: 'shell', workspaces: [{ path: '/a', readOnly: false }] });
    upstreamSaw = null;
    resets = 0;
  });

  it('bekend secret → door, zonder Proxy-Authorization richting upstream of in de audit', async () => {
    expect((await proxyGet(basic('box', SECRET))).status).toBe(200);
    expect(upstreamSaw).not.toBeNull();
    expect(upstreamSaw!['proxy-authorization']).toBeUndefined();
    const rows = dbMod.db.prepare(`SELECT container_id, req_headers FROM audit_log WHERE domain = '127.0.0.1'`).all() as any[];
    expect(rows.map((r) => r.container_id)).toEqual(['sbx:box']);
    expect(rows[0].req_headers).not.toContain(SECRET);
  });

  it('geen, onbekend of verkeerd-benoemd secret → 407, upstream niet geraakt', async () => {
    for (const auth of [undefined, basic('box', 'B'.repeat(43)), basic('other', SECRET), 'Bearer x']) {
      const r = await proxyGet(auth);
      expect(r.status).toBe(407);
      expect(r.headers['proxy-authenticate']).toMatch(/^Basic/);
    }
    expect(upstreamSaw).toBeNull();
    expect(resets).toBe(0);
  });

  it('reset-secret → 407 en de recreate-trigger', async () => {
    expect((await proxyGet(basic('_huddle-reset', store.resetSecret()))).status).toBe(407);
    expect(resets).toBe(1);
  });

  it('uitgeschakeld → ook een bekend secret krijgt 407', async () => {
    store.setEnabled(false);
    expect((await proxyGet(basic('box', SECRET))).status).toBe(407);
  });

  it('host huddle blijft dicht, ook voor een bekende sandbox', async () => {
    expect((await proxyGet(basic('box', SECRET), 'huddle:3000')).status).toBe(403);
  });

  it('CONNECT: bekende sandbox krijgt een ruwe tunnel, onbekende 407', async () => {
    const ok = await proxyConnect(basic('box', SECRET));
    expect(ok.statusLine).toMatch(/ 200 /);
    expect(ok.echoed).toBe('ping');
    expect((await proxyConnect()).statusLine).toMatch(/^HTTP\/1\.1 407 /);
  });
});
