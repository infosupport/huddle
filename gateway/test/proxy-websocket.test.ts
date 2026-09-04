import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { forwardableHost } from './helpers/upstream-host';
import http from 'http';
import net from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';

// ── WebSocket proxying (#74) ────────────────────────────────────────────────
// The proxy must forward HTTP Upgrade handshakes (WebSocket), not only
// regular requests. Node emits an upgrade as a SEPARATE 'upgrade' event;
// without a handler the gateway closed the socket and timed out the handshake (the
// Codex CLI delay). This suite pins the plain-HTTP path (`ws://`):
// a real local ws echo server upstream, a real ws client that connects via the proxy
// as a forward-proxy client. The MITM path (`wss://`) shares exactly
// the same forwardUpgrade helper and path enforcement.

// Niet 127.0.0.1: de proxy weigert alles wat aan Huddle zelf gericht is, en dat
// is het hele 127.0.0.0/8-blok (src/proxy-self.ts). Een upstream op loopback
// levert 403 op nog voordat er een regel bekeken wordt.
const upstreamHost = forwardableHost();

let db: typeof import('../src/db').db;
// The proxy holds no policy of its own and denies until a plane is bound; see
// test/helpers/local-plane.ts. Rules written straight into the database become
// visible to it at refresh(), and what it decided reaches the audit log at
// flush() — the same two moments a real gateway has.
let control: import('./helpers/local-plane').LocalPlane;

let upstream: WebSocketServer;
let upstreamPort = 0;
let lastUpstreamHeaders: Record<string, any> = {};

let proxy: http.Server;
let proxyPort = 0;

// createConnection hook for the ws client: the client thinks it talks directly
// to the upstream (Host header + path are therefore correct), but the TCP
// connection goes to the proxy. The first write (the handshake request line)
// is rewritten from origin form (`GET /path`) to the absolute form that a
// forward proxy expects (`GET http://host:port/path`) — exactly what an
// HTTP proxy client (Codex with HTTPS_PROXY) puts on the wire.
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
          `GET http://${upstreamHost}:${upstreamP}$1 HTTP/1.1`
        );
        return origWrite(Buffer.from(str, 'utf8'), typeof enc === 'function' ? undefined : enc, typeof enc === 'function' ? enc : cb);
      }
      return origWrite(chunk, enc, cb);
    };
    return socket as any;
  };
}

// Connect a ws client via the proxy to the upstream. Resolves with the message
// the echo server bounces back (proves end-to-end proxying), or rejects.
function wsEchoViaProxy(path: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${upstreamHost}:${upstreamPort}${path}`, {
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

// When deliberately blocked: expect that the handshake does NOT succeed. Resolves with the
// HTTP status of the rejection (403) or with 'error' on a socket failure — both
// prove that no tunnel was established.
function wsExpectRejected(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${upstreamHost}:${upstreamPort}${path}`, {
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

// Upstream that accepts the TCP connection but NEVER completes the handshake.
// Proves the socket-leak backstop: without a handshake timeout such a
// half-open upgrade keeps both sockets held indefinitely (FD-exhaustion DoS).
let stallUpstream: net.Server;
let stallPort = 0;
let stallAccepted = 0;
const stallSockets: net.Socket[] = [];

describe.skipIf(!upstreamHost)('proxy forwards WebSocket upgrades', () => {
  beforeAll(async () => {
    // Short handshake timeout so the leak regression test is fast; production
    // falls back to the 30s default.
    process.env.WS_UPGRADE_TIMEOUT_MS = '800';
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();

    // No Docker in the unit environment: the client IP resolves to no container
    // (the plane is given an empty map) — rules at the global level suffice.
    const { createLocalPlane } = await import('./helpers/local-plane');
    const { setControlPlane } = await import('../src/control/plane');
    control = await createLocalPlane();
    setControlPlane(control.plane);

    // Upstream: real ws echo server.
    upstream = new WebSocketServer({ host: upstreamHost!, port: 0 });
    upstream.on('connection', (socket, req) => {
      lastUpstreamHeaders = req.headers;
      socket.on('message', (data) => socket.send(data.toString()));
    });
    await new Promise<void>((r) => upstream.once('listening', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    // Stalled upstream: accepts TCP, never answers.
    stallUpstream = net.createServer((s) => {
      stallAccepted++;
      stallSockets.push(s);
    });
    await new Promise<void>((r) => stallUpstream.listen(0, upstreamHost!, () => r()));
    stallPort = (stallUpstream.address() as AddressInfo).port;

    const { createProxyServer } = await import('../src/proxy');
    proxy = createProxyServer(0);
    await new Promise<void>((r) => proxy.once('listening', () => r()));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const { resetControlPlane } = await import('../src/control/plane');
    resetControlPlane();
    // Force-close any remaining sockets (e.g. the proxy→stall-upstream
    // connection) so server.close() does not hang on teardown.
    (proxy as any)?.closeAllConnections?.();
    for (const s of stallSockets) { try { s.destroy(); } catch {} }
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    await new Promise<void>((r) => (stallUpstream ? stallUpstream.close(() => r()) : r()));
    delete process.env.WS_UPGRADE_TIMEOUT_MS;
  });

  beforeEach(async () => {
    db.exec('DELETE FROM rules');
    await control.refresh();
  });

  it('proxies an allowed WebSocket upgrade end-to-end (echo)', async () => {
    // Host-only allow for the upstream host → every path allowed.
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, NULL, 'allow')`).run(upstreamHost);
    await control.refresh();
    const echoed = await wsEchoViaProxy('/echo', 'hello huddle');
    expect(echoed).toBe('hello huddle');
  });

  it('strips + redacts Proxy-Authorization and records the handshake result in the audit log', async () => {
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, NULL, 'allow')`).run(upstreamHost);
    await control.refresh();
    lastUpstreamHeaders = {};
    const echoed = await new Promise<string>((resolve, reject) => {
      // Low-entropy, obviously-fake marker (NOT a real credential): we only assert
      // it is stripped from upstream and redacted from the audit log.
      const ws = new WebSocket(`ws://${upstreamHost}:${upstreamPort}/echo`, {
        createConnection: proxyCreateConnection(upstreamPort, proxyPort),
        headers: { 'Proxy-Authorization': 'Basic not-a-real-proxy-cred' },
      } as any);
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (d) => { ws.close(); resolve(d.toString()); });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    expect(echoed).toBe('hi');
    // The reusable proxy credential must NOT reach upstream…
    expect(lastUpstreamHeaders['proxy-authorization']).toBeUndefined();
    // …and the audit row must be completed (101) with the credential redacted.
    // The gateway batches its writes, so nothing is in the database until the
    // report is posted.
    await control.flush();
    const row = db.prepare(
      `SELECT res_status, req_headers FROM audit_log WHERE action = 'allow' AND domain = ? ORDER BY id DESC LIMIT 1`
    ).get(upstreamHost) as { res_status: number | null; req_headers: string | null };
    expect(row.res_status).toBe(101);
    expect(row.req_headers ?? '').not.toContain('not-a-real-proxy-cred');
    expect(row.req_headers ?? '').toContain('<redacted>');
  });

  it('rejects an upgrade to a disallowed host/path (403)', async () => {
    // No allow rule → checkRule returns 'requested' → fail-closed rejected.
    const result = await wsExpectRejected('/echo');
    expect(result).toBe('http:403');
  });

  it('refuses a non-WebSocket "upgrade" so it cannot bypass the request pipeline', async () => {
    // Attack: a client sends POST /v1/oauth/token with Upgrade: websocket to an
    // allowed host. Node routes it to the 'upgrade' event; if the proxy forwarded
    // it as an upgrade, it would skip handleTokenExchangeResponse and leak the real
    // bearer token. The handshake gate must refuse it (400) before dialing upstream.
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, NULL, 'allow')`).run(upstreamHost);
    await control.refresh();
    const status = await new Promise<string>((resolve, reject) => {
      const c = net.connect(proxyPort, '127.0.0.1');
      let buf = '';
      const guard = setTimeout(() => { try { c.destroy(); } catch {} reject(new Error('timeout')); }, 4000);
      c.on('connect', () => {
        c.write(
          `POST http://${upstreamHost}:${upstreamPort}/v1/oauth/token HTTP/1.1\r\n` +
          `Host: ${upstreamHost}:${upstreamPort}\r\n` +
          `Connection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 0\r\n\r\n`
        );
      });
      c.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/^HTTP\/1\.1 (\d{3} [^\r\n]+)/);
        if (m) { clearTimeout(guard); try { c.destroy(); } catch {} resolve(m[1]); }
      });
      c.on('error', (e) => { clearTimeout(guard); reject(e); });
    });
    // Refused, not forwarded — and the status line is consistent (not "400 Forbidden").
    expect(status).toBe('400 Bad Request');
  });

  it('cuts off a stalled upstream handshake (no socket-leak DoS)', async () => {
    // Host allowed, but upstream never completes the handshake. Without the
    // handshake timeout the client socket stays open indefinitely (Node's server
    // timeouts do not apply on a hijacked upgrade socket). Expect: the
    // proxy dials upstream (allow) and then closes the client socket itself.
    db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, NULL, 'allow')`).run(upstreamHost);
    await control.refresh();
    const before = stallAccepted;
    // Measure how long the client socket stays open. Without a handshake timeout
    // the proxy never closes it (Node's server timeouts do not apply on a
    // hijacked upgrade socket) and this would hit the 4s guard.
    const start = Date.now();
    const closedAfterMs = await new Promise<number>((resolve) => {
      const c = net.connect(proxyPort, '127.0.0.1');
      const guard = setTimeout(() => { try { c.destroy(); } catch {} resolve(-1); }, 4000);
      c.on('connect', () => {
        c.write(
          `GET http://${upstreamHost}:${stallPort}/echo HTTP/1.1\r\n` +
          `Host: ${upstreamHost}:${stallPort}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          // Arbitrary dummy handshake key (16 null bytes, base64) — no secret;
          // the stall upstream never answers anyway, so the value does not matter.
          `Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      const done = () => { clearTimeout(guard); resolve(Date.now() - start); };
      c.on('close', done);
      c.on('error', done);
    });
    expect(stallAccepted).toBeGreaterThan(before); // proxy dialed upstream (allow)
    // The backstop cut off the half-open handshake: closed after the 800ms timeout,
    // well before the 4s guard. -1 = never closed = leak (regression).
    expect(closedAfterMs).toBeGreaterThanOrEqual(0);
    expect(closedAfterMs).toBeLessThan(3000);
  }, 8000);
});
