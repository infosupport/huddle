import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import net from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';

// ── WebSocket-proxying (#74) ────────────────────────────────────────────────
// De proxy moet HTTP Upgrade-handshakes (WebSocket) forwarden, niet alleen
// gewone requests. Node emit't een upgrade als een SEPARAAT 'upgrade'-event;
// zonder handler sloot de gateway de socket en time-outte de handshake (de
// Codex-CLI-vertraging). Deze suite pint het plain-HTTP-pad (`ws://`) vast:
// een echte lokale ws-echoserver upstream, een echte ws-client die via de proxy
// als forward-proxy-client verbindt. Het MITM-pad (`wss://`) deelt exact
// dezelfde forwardUpgrade-helper en padhandhaving.
//
// better-sqlite3 is een native module; zonder gebouwde binding slaan we de suite
// over (zie rules.test.ts / proxy-forward-path.test.ts). Probe vóór de db-import.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[proxy-websocket.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;

let upstream: WebSocketServer;
let upstreamPort = 0;

let proxy: http.Server;
let proxyPort = 0;

// createConnection-hook voor de ws-client: de client denkt dat hij rechtstreeks
// met de upstream praat (Host-header + pad kloppen daardoor), maar de TCP-
// verbinding gaat naar de proxy. De eerste write (de handshake-request-regel)
// wordt herschreven van origin-vorm (`GET /pad`) naar de absolute vorm die een
// forward-proxy verwacht (`GET http://host:poort/pad`) — precies wat een
// HTTP-proxy-client (Codex met HTTPS_PROXY) op de draad zet.
function proxyCreateConnection(upstreamP: number, proxyP: number) {
  return () => {
    const socket = net.connect(proxyP, '127.0.0.1');
    const origWrite = socket.write.bind(socket) as typeof socket.write;
    let rewritten = false;
    (socket as any).write = (chunk: any, enc?: any, cb?: any) => {
      if (!rewritten) {
        rewritten = true;
        const str = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).replace(
          /^GET (\/[^ ]*) HTTP\/1\.1/,
          `GET http://127.0.0.1:${upstreamP}$1 HTTP/1.1`
        );
        return origWrite(Buffer.from(str, 'utf8'), typeof enc === 'function' ? undefined : enc, typeof enc === 'function' ? enc : cb);
      }
      return origWrite(chunk, enc, cb);
    };
    return socket as any;
  };
}

// Verbind een ws-client via de proxy naar de upstream. Resolvet met het bericht
// dat de echo-server terugkaatst (bewijst end-to-end proxying), of rejectet.
function wsEchoViaProxy(path: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${upstreamPort}${path}`, {
      createConnection: proxyCreateConnection(upstreamPort, proxyPort),
    } as any);
    ws.on('open', () => ws.send(payload));
    ws.on('message', (data) => {
      ws.close();
      resolve(data.toString());
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`unexpected ${res.statusCode}`)));
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

// Als bewust-geblokkeerd: verwacht dat de handshake NIET slaagt. Resolvet met de
// HTTP-status van de weigering (403) of met 'error' bij een socketfout — beide
// bewijzen dat er geen tunnel tot stand kwam.
function wsExpectRejected(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${upstreamPort}${path}`, {
      createConnection: proxyCreateConnection(upstreamPort, proxyPort),
    } as any);
    ws.on('open', () => {
      ws.close();
      reject(new Error('handshake unexpectedly succeeded'));
    });
    ws.on('unexpected-response', (_req, res) => resolve(`http:${res.statusCode}`));
    ws.on('error', (err) => resolve(`error:${err.message}`));
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

// Upstream die de TCP-verbinding accepteert maar de handshake NOOIT afrondt.
// Bewijst de socket-leak-backstop: zonder handshake-timeout blijft zo'n
// half-open upgrade beide sockets onbeperkt vasthouden (FD-exhaustion DoS).
let stallUpstream: net.Server;
let stallPort = 0;
let stallAccepted = 0;
const stallSockets: net.Socket[] = [];

describe.skipIf(!sqliteAvailable)('proxy forwards WebSocket upgrades', () => {
  beforeAll(async () => {
    // Korte handshake-timeout zodat de leak-regressietest snel is; productie
    // valt terug op de 30s-default.
    process.env.WS_UPGRADE_TIMEOUT_MS = '800';
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();

    // Geen Docker in de unit-omgeving: client-IP resolvet niet naar een
    // container — regels op globaal niveau volstaan.
    const dockerMod = await import('../src/docker');
    vi.spyOn(dockerMod, 'resolveContainerByIp').mockResolvedValue(null);

    // Upstream: echte ws-echoserver.
    upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    upstream.on('connection', (socket) => {
      socket.on('message', (data) => socket.send(data.toString()));
    });
    await new Promise<void>((r) => upstream.once('listening', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    // Stalled upstream: accepteert TCP, antwoordt nooit.
    stallUpstream = net.createServer((s) => {
      stallAccepted++;
      stallSockets.push(s);
    });
    await new Promise<void>((r) => stallUpstream.listen(0, '127.0.0.1', () => r()));
    stallPort = (stallUpstream.address() as AddressInfo).port;

    const { createProxyServer } = await import('../src/proxy');
    proxy = createProxyServer(0);
    await new Promise<void>((r) => proxy.once('listening', () => r()));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    // Force-close eventuele resterende sockets (bv. de proxy→stall-upstream
    // verbinding) zodat server.close() niet blijft hangen op de teardown.
    (proxy as any)?.closeAllConnections?.();
    for (const s of stallSockets) { try { s.destroy(); } catch {} }
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    await new Promise<void>((r) => (stallUpstream ? stallUpstream.close(() => r()) : r()));
    delete process.env.WS_UPGRADE_TIMEOUT_MS;
  });

  beforeEach(() => {
    db.exec('DELETE FROM rules');
  });

  it('proxyt een toegestane WebSocket-upgrade end-to-end (echo)', async () => {
    // Host-only allow voor de upstream-host → elk pad toegestaan.
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('127.0.0.1', NULL, 'allow')`).run();
    const echoed = await wsEchoViaProxy('/echo', 'hallo huddle');
    expect(echoed).toBe('hallo huddle');
  });

  it('weigert een upgrade naar een niet-toegestane host/pad (403)', async () => {
    // Geen allow-regel → checkRule levert 'requested' op → fail-closed geweigerd.
    const result = await wsExpectRejected('/echo');
    expect(result).toBe('http:403');
  });

  it('kapt een stalled upstream-handshake af (geen socket-leak DoS)', async () => {
    // Host toegestaan, maar upstream rondt de handshake nooit af. Zonder de
    // handshake-timeout blijft de client-socket onbeperkt open (Node's server-
    // timeouts gelden niet op een ge-hijackte upgrade-socket). Verwacht: de
    // proxy dialt upstream (allow) én sluit daarna de client-socket zelf.
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('127.0.0.1', NULL, 'allow')`).run();
    const before = stallAccepted;
    // Meet hoe lang de client-socket open blijft. Zonder handshake-timeout
    // sluit de proxy hem nooit (Node's server-timeouts gelden niet op een
    // ge-hijackte upgrade-socket) en zou dit de 4s-guard raken.
    const start = Date.now();
    const closedAfterMs = await new Promise<number>((resolve) => {
      const c = net.connect(proxyPort, '127.0.0.1');
      const guard = setTimeout(() => { try { c.destroy(); } catch {} resolve(-1); }, 4000);
      c.on('connect', () => {
        c.write(
          `GET http://127.0.0.1:${stallPort}/echo HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${stallPort}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      const done = () => { clearTimeout(guard); resolve(Date.now() - start); };
      c.on('close', done);
      c.on('error', done);
    });
    expect(stallAccepted).toBeGreaterThan(before); // proxy dialde upstream (allow)
    // De backstop kapte de half-open handshake af: dicht ná de 800ms-timeout,
    // ruim vóór de 4s-guard. -1 = nooit gesloten = leak (regressie).
    expect(closedAfterMs).toBeGreaterThanOrEqual(0);
    expect(closedAfterMs).toBeLessThan(3000);
  }, 8000);
});
