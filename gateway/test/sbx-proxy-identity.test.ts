import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { forwardableHost } from './helpers/upstream-host';

// The sbx listener decides WHOSE request it is from the proxy credential, and
// then takes the ordinary per-container path — `checkRule(host, '<name>')`,
// the same call a devcontainer takes. See docs/ADR-sbx-identity.md.
//
// This drives the real proxy against a real upstream, with the control plane
// stubbed: a fake plane records every checkRule it is asked, so the test can
// assert WHICH box a request was judged as, not merely that it was allowed. No
// database and no native binding — the whole mechanism is header-shaped.
//
// The upstream is not on loopback: the proxy refuses everything addressed to
// Huddle itself, which is all of 127.0.0.0/8 (helpers/upstream-host.ts).

const upstreamHost = forwardableHost();

// A port the proxy is willing to consider its sbx listener. The gateway decides
// that by comparing against SBX_PROXY_PORT, so the test moves the port rather
// than adding a switch the production code would not otherwise have.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
}

interface RuleCall { domain: string; containerId: string | null; path: string | null }

let ruleCalls: RuleCall[] = [];
let upstreamHeaders: http.IncomingHttpHeaders | null = null;

let upstream: http.Server;
let upstreamPort = 0;
let sbxProxy: http.Server;
let sbxPort = 0;
let dcProxy: http.Server;
let dcPort = 0;
// Every socket these servers accept. A CONNECT detaches its socket from the
// server that accepted it, so neither close() nor closeAllConnections() will
// ever reap it and the suite would hang on teardown.
const openSockets = new Set<net.Socket>();

function track(srv: http.Server): http.Server {
  srv.on('connection', (s) => {
    openSockets.add(s);
    s.on('close', () => openSockets.delete(s));
  });
  return srv;
}

const SECRET_A = 'secret-for-box-a';
const SECRET_B = 'secret-for-box-b';

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

interface ProxyResult { status: number; body: string }

/** One plain-HTTP request through a forward proxy, absolute request-target. */
function proxyGet(port: number, headers: http.OutgoingHttpHeaders = {}): Promise<ProxyResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        // No keep-alive: a pooled socket outlives the test and hangs close().
        agent: false,
        path: `http://${upstreamHost}:${upstreamPort}/thing`,
        headers: { host: `${upstreamHost}:${upstreamPort}`, ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * One CONNECT through the proxy, answered with the raw status line.
 *
 * Deliberately to a non-443 port: that takes the raw-tunnel branch and skips the
 * MITM, so this suite tests the identity check at CONNECT rather than the CA.
 */
function proxyConnect(port: number, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      sock.write(
        `CONNECT ${upstreamHost}:${upstreamPort} HTTP/1.1\r\n` +
        `Host: ${upstreamHost}:${upstreamPort}\r\n${extra}\r\n`
      );
    });
    let seen = '';
    sock.on('data', (c) => {
      seen += c.toString('utf8');
      if (seen.includes('\r\n\r\n')) { sock.destroy(); resolve(seen); }
    });
    sock.on('error', reject);
    sock.on('close', () => resolve(seen));
  });
}

describe.skipIf(!upstreamHost)('the sbx listener identifies the calling sandbox', () => {
  beforeAll(async () => {
    sbxPort = await freePort();
    // Read once at import time by runtime-env, so it has to be set before the
    // first import of anything that reaches it.
    process.env.HUDDLE_SBX_PROXY_PORT = String(sbxPort);

    const { hashSandboxSecret, sameHash } = await import('../src/sbx-identity');
    const { setControlPlane } = await import('../src/control/plane');

    const sandboxAuth: Record<string, string> = {
      [hashSandboxSecret(SECRET_A)]: 'box-a',
      [hashSandboxSecret(SECRET_B)]: 'box-b',
    };

    setControlPlane({
      // Only box-a may reach the upstream. box-b exists and is recognised, but
      // its rules are its own — which is the property the fleet merge destroyed.
      // There is no checkFleetRule left to fall back to: it is gone from the
      // ControlPlane interface, so this is the only decision path there is.
      checkRule: (domain, containerId, path) => {
        ruleCalls.push({ domain, containerId, path });
        return containerId === 'box-a'
          ? { status: 'allow', ruleId: 1 }
          : { status: 'requested', ruleId: null };
      },
      isPathMode: () => false,
      resolveContainerByIp: async () => null,
      resolveSandboxBySecret: (secret) => {
        const presented = hashSandboxSecret(secret);
        for (const [hash, name] of Object.entries(sandboxAuth)) {
          if (sameHash(presented, hash)) return name;
        }
        return null;
      },
      logAudit: () => 1,
      updateAuditResponse: () => {},
      reportSudoAudit: () => {},
    });

    upstream = track(http.createServer((req, res) => {
      upstreamHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }));
    await new Promise<void>((r) => upstream.listen(0, upstreamHost!, () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const { createProxyServer } = await import('../src/proxy');
    sbxProxy = track(createProxyServer(sbxPort));
    await new Promise<void>((r) => sbxProxy.once('listening', () => r()));
    // A second listener on an ordinary port, to pin that the credential is only
    // honoured where sandboxes actually arrive.
    dcProxy = track(createProxyServer(0));
    await new Promise<void>((r) => dcProxy.once('listening', () => r()));
    dcPort = (dcProxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const { resetControlPlane } = await import('../src/control/plane');
    resetControlPlane();
    delete process.env.HUDDLE_SBX_PROXY_PORT;
    for (const sock of openSockets) sock.destroy();
    openSockets.clear();
    for (const srv of [sbxProxy, dcProxy, upstream]) {
      if (!srv) continue;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  beforeEach(() => {
    ruleCalls = [];
    upstreamHeaders = null;
  });

  it('judges a known credential as that box, and lets its own rules through', async () => {
    const res = await proxyGet(sbxPort, { 'proxy-authorization': basic('box-a', SECRET_A) });
    expect(res.status).toBe(200);
    expect(ruleCalls).toEqual([{ domain: upstreamHost, containerId: 'box-a', path: '/thing' }]);
  });

  it('gives one box the rules of one box, not of every box', async () => {
    const res = await proxyGet(sbxPort, { 'proxy-authorization': basic('box-b', SECRET_B) });
    // box-a is allowed to reach this host; box-b is not, and there is no merge
    // left that would let box-b inherit it.
    expect(res.status).toBe(403);
    expect(ruleCalls).toEqual([{ domain: upstreamHost, containerId: 'box-b', path: '/thing' }]);
  });

  it('believes the secret, not the name on it', async () => {
    // The username is a routing hint and nothing more — every security property
    // lives in the password (ADR §5).
    const res = await proxyGet(sbxPort, { 'proxy-authorization': basic('box-a', SECRET_B) });
    expect(res.status).toBe(403);
    expect(ruleCalls[0]?.containerId).toBe('box-b');
  });

  it('denies a credential it cannot place, and says which of the two causes it is', async () => {
    const res = await proxyGet(sbxPort, { 'proxy-authorization': basic('box-c', 'guessed') });
    expect(res.status).toBe(403);
    expect(res.body).toContain('matches no sandbox');
    // Named so an operator can act: removed, or the feed has not caught up.
    expect(res.body).toContain('stale');
    // Never evaluated against anything. A request with no identity is not a
    // request with a wider identity.
    expect(ruleCalls).toEqual([]);
  });

  it('denies the unclaimed credential by name', async () => {
    const { UNCLAIMED_SANDBOX } = await import('../src/sbx-identity');
    const res = await proxyGet(sbxPort, { 'proxy-authorization': basic(UNCLAIMED_SANDBOX, 'parked') });
    expect(res.status).toBe(403);
    // The whole reason the unclaimed credential exists: a box that re-read the
    // global setting is denied under its own name instead of inheriting the
    // rights of whichever box was created last.
    expect(res.body).toContain(UNCLAIMED_SANDBOX);
    expect(ruleCalls).toEqual([]);
  });

  it('denies a request with no credential at all', async () => {
    const res = await proxyGet(sbxPort);
    expect(res.status).toBe(403);
    expect(res.body).toContain('No sandbox credential');
    expect(ruleCalls).toEqual([]);
  });

  it('denies a credential that is not Basic', async () => {
    const res = await proxyGet(sbxPort, { 'proxy-authorization': 'Bearer secret-for-box-a' });
    expect(res.status).toBe(403);
    expect(ruleCalls).toEqual([]);
  });

  it('never forwards the credential upstream', async () => {
    const res = await proxyGet(sbxPort, { 'proxy-authorization': basic('box-a', SECRET_A) });
    expect(res.status).toBe(200);
    // It authenticates the hop to us and is meant for nobody behind us.
    expect(upstreamHeaders).not.toBeNull();
    expect(upstreamHeaders!['proxy-authorization']).toBeUndefined();
    expect(JSON.stringify(upstreamHeaders)).not.toContain(SECRET_A);
  });

  it('identifies the box at CONNECT, which is where the traffic actually is', async () => {
    const seen = await proxyConnect(sbxPort, { 'Proxy-Authorization': basic('box-a', SECRET_A) });
    expect(seen).toContain('200 Connection Established');
    expect(ruleCalls).toEqual([{ domain: upstreamHost, containerId: 'box-a', path: null }]);
  });

  it('denies a CONNECT it cannot attribute', async () => {
    const seen = await proxyConnect(sbxPort, { 'Proxy-Authorization': basic('box-c', 'guessed') });
    expect(seen).toContain('403 Forbidden');
    expect(seen).toContain('matches no sandbox');
    expect(ruleCalls).toEqual([]);
  });

  it('denies a CONNECT with no credential', async () => {
    const seen = await proxyConnect(sbxPort);
    expect(seen).toContain('403 Forbidden');
    expect(seen).toContain('No sandbox credential');
    expect(ruleCalls).toEqual([]);
  });

  it('does not let a devcontainer claim a sandbox identity', async () => {
    // The same credential on the ordinary listener buys nothing: a devcontainer
    // is identified by its source address, and this listener never asks the
    // header. Otherwise anything that could reach the proxy port could pick a
    // scope for itself.
    const res = await proxyGet(dcPort, { 'proxy-authorization': basic('box-a', SECRET_A) });
    expect(ruleCalls).toEqual([{ domain: upstreamHost, containerId: null, path: '/thing' }]);
    expect(res.status).toBe(403);
  });
});
