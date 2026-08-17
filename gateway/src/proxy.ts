import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import stream from 'stream';
import zlib from 'zlib';
import { URL } from 'url';
import { checkRule, checkFleetRule, isPathMode, canonicalizeHost, normalizePathname } from './rules';
import { knownSandboxNames } from './sandbox/registry';
import { resolveContainerByIp } from './docker';
import { SBX_PROXY_PORT } from './sbx';
import { logAudit, updateAuditResponse } from './db';
import { signLeafCert } from './tls-ca';
import { storeTokenExchange, resolveToken, isPlaceholderToken, managesTokenExchange } from './token-exchange';
import { logIdentityProbe } from './identity-probe';

const PROXY_PORT = 80;

// Domains that skip the MITM (keep a raw TCP tunnel). For clients with
// cert-pinning (npm registry, some Java libs) MITM is a breaker.
const NO_INTERCEPT_DOMAINS: Set<string> = new Set(
  (process.env.NO_INTERCEPT_DOMAINS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
);

const CAP = 20 * 1024; // 20 KB per field
function cap(s: string): string { return s.length > CAP ? s.slice(0, CAP) + '\n[truncated]' : s; }
function headersToJson(h: Record<string, any>): string { try { return cap(JSON.stringify(h)); } catch { return '{}'; } }

// Hop-by-hop proxy headers that must never reach upstream: proxy-connection and
// the reusable proxy credential proxy-authorization.
function stripProxyHeaders(h: http.OutgoingHttpHeaders): void {
  delete h['proxy-connection'];
  delete h['proxy-authorization'];
}

// Serialize request headers for the audit log with the reusable proxy credential
// redacted, so it is never persisted in the network log.
function auditReqHeaders(h: http.IncomingHttpHeaders): string {
  return h['proxy-authorization'] === undefined
    ? headersToJson(h)
    : headersToJson({ ...h, 'proxy-authorization': '<redacted>' });
}

// RFC 7230 §3.3.2: Content-Length and Transfer-Encoding must not coexist.
// Some OAuth/API servers send both; strip Content-Length when TE is present.
function sanitizeResHeaders(h: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  if (!h['transfer-encoding'] || !h['content-length']) return h;
  const out = { ...h };
  delete out['content-length'];
  return out;
}

function decodeBody(chunks: Buffer[], headers: http.IncomingHttpHeaders): string | null {
  if (chunks.length === 0) return null;
  const buf = Buffer.concat(chunks);
  const enc = ((headers['content-encoding'] as string) ?? '').toLowerCase();
  try {
    let decoded: Buffer;
    if (enc === 'gzip' || enc === 'x-gzip') decoded = zlib.gunzipSync(buf);
    else if (enc === 'deflate') decoded = zlib.inflateSync(buf);
    else if (enc === 'br') decoded = zlib.brotliDecompressSync(buf);
    else decoded = buf;
    return cap(decoded.toString('utf8'));
  } catch {
    return '[binary / not decodable]';
  }
}

function send403(res: http.ServerResponse, domain: string, status: string, containerId?: string | null): void {
  const body = JSON.stringify({
    error: 'REQUEST_BLOCKED_BY_HUDDLE',
    message: 'This request is blocked by Huddle security policy.',
    blockedEndpoint: domain,
    reason: status === 'requested'
      ? 'This endpoint has not yet been approved for this devcontainer.'
      : 'This endpoint is denied by a firewall rule.',
    actionRequired: 'The user must approve this endpoint in the Huddle portal (http://huddle:3000) before this request can continue.',
    devcontainerId: containerId ?? undefined,
    huddlePortal: 'http://localhost:3000',
  });
  res.writeHead(403, {
    'content-type': 'application/json',
    'x-huddle-blocked': '1',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function send502(res: http.ServerResponse, message: string): void {
  const body = JSON.stringify({ error: 'bad_gateway', message });
  res.writeHead(502, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Reason phrase per status so the status line is never self-contradictory
// (e.g. "400 Forbidden"). rejectSocket serves both CONNECT and Upgrade denials.
const REJECT_REASON: Record<number, string> = {
  400: 'Bad Request', 403: 'Forbidden', 426: 'Upgrade Required',
  502: 'Bad Gateway', 504: 'Gateway Timeout',
};

function rejectSocket(socket: stream.Duplex, status: number, blockStatus: string, domain: string, containerId?: string | null): void {
  const body = JSON.stringify({
    error: 'REQUEST_BLOCKED_BY_HUDDLE',
    message: 'This request is blocked by Huddle security policy.',
    blockedEndpoint: domain,
    reason: blockStatus === 'requested'
      ? 'This endpoint has not yet been approved for this devcontainer.'
      : 'This endpoint is denied by a firewall rule.',
    actionRequired: 'The user must approve this endpoint in the Huddle portal (http://huddle:3000) before this request can continue.',
    devcontainerId: containerId ?? undefined,
    huddlePortal: 'http://localhost:3000',
  });
  socket.write(
    `HTTP/1.1 ${status} ${REJECT_REASON[status] ?? 'Forbidden'}\r\n` +
      `content-type: application/json\r\n` +
      `x-huddle-blocked: 1\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n` +
      body
  );
  socket.end();
}

// Forward an HTTP Upgrade handshake (WebSocket `ws://`/`wss://`, but also any
// other Upgrade) to upstream and then pipe the raw bytes in both
// directions. `secure` chooses between http.request (plain, after the plain-HTTP path) and
// https.request (TLS, after MITM termination). We deliberately use the lowest layer:
// Node emits 'upgrade' on the ClientRequest as soon as upstream answers with 101;
// then we reconstruct the handshake response byte-for-byte back to the client
// (rawHeaders preserves exact casing + order of Sec-WebSocket-Accept etc.) and
// connect both sockets. Every Upgrade is thus forwarded transparently.
// Reconstruct an HTTP status line + headers byte-for-byte from an upstream
// response, preserving exact header casing/order (rawHeaders). Shared by the
// 101-handshake relay and the non-101 response relay in forwardUpgrade.
function formatHttpHead(res: http.IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

// A genuine WebSocket handshake is a GET carrying `Upgrade: websocket`, a
// `Connection` list that includes `upgrade`, and a Sec-WebSocket-Key (RFC 6455).
// ONLY such requests may take the raw upgrade path. Node routes *any* request
// with Upgrade headers to the 'upgrade' event, so without this gate a client
// could send e.g. `POST /v1/oauth/token` with `Upgrade: websocket` and have it
// forwarded verbatim — skipping the normal request pipeline and its response
// scrubbing (handleTokenExchangeResponse), leaking the real bearer token to the
// container. Non-handshake "upgrades" are refused so they fall to no path at all.
function isWebSocketHandshake(method: string | undefined, headers: http.IncomingHttpHeaders): boolean {
  if ((method ?? '').toUpperCase() !== 'GET') return false;
  if (String(headers['upgrade'] ?? '').toLowerCase() !== 'websocket') return false;
  const connection = String(headers['connection'] ?? '').toLowerCase();
  if (!connection.split(',').some((t) => t.trim() === 'upgrade')) return false;
  const key = headers['sec-websocket-key'];
  return typeof key === 'string' && key.length > 0;
}

function forwardUpgrade(
  secure: boolean,
  options: https.RequestOptions,
  clientSocket: stream.Duplex,
  clientHead: Buffer,
  auditId: number | null = null,
): void {
  // Record the handshake outcome on the in-flight audit row exactly once, so an
  // allowed upgrade never stays res_status=NULL in the network log. First
  // terminal outcome wins — a later live-socket error must not overwrite the 101.
  let audited = false;
  const finishAudit = (resStatus: number | null) => {
    if (audited || auditId === null) return;
    audited = true;
    updateAuditResponse(auditId, { resStatus });
  };

  let upstreamReq: http.ClientRequest;
  try {
    // Same synchronous-throw risk as tryCreateUpstreamRequest (e.g.
    // ERR_UNESCAPED_CHARACTERS): fail per handshake, not per process.
    upstreamReq = secure ? https.request(options) : http.request(options);
  } catch {
    finishAudit(502);
    try { clientSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ }
    return;
  }

  // Handshake timeout: an upstream that does accept the TCP connection but
  // never completes the upgrade (stalled/slowloris, or a SYN that disappears
  // into a blackhole) otherwise keeps both the client and the upstream socket
  // open indefinitely. Node's server-/headersTimeout no longer apply on a hijacked
  // upgrade socket, so without this backstop a devcontainer with a single
  // allowed host can pile up unlimited half-open handshakes and exhaust the FDs of
  // the shared gateway (DoS). We guard only the handshake
  // phase; as soon as upstream gives 101/response we clear the timer, so legitimate
  // long-lived WebSockets are never cut off.
  // upstreamReq.destroy() aborts the request but does not always close the already
  // connected socket (it can linger in the agent pool) — so also destroy
  // upstreamReq.socket explicitly, otherwise the outgoing gateway socket leaks.
  const destroyUpstream = () => {
    try { upstreamReq.socket?.destroy(); } catch { /* best-effort: peer socket may already be closed */ }
    try { upstreamReq.destroy(); } catch { /* best-effort: peer socket may already be closed */ }
  };
  const timeoutMs = Number(process.env.WS_UPGRADE_TIMEOUT_MS) || 30_000;
  let settled = false;
  const handshakeTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    destroyUpstream();
    finishAudit(504);
    try { clientSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ }
  }, timeoutMs);
  handshakeTimer.unref?.();
  const clearHandshakeTimer = () => { settled = true; clearTimeout(handshakeTimer); };

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    clearHandshakeTimer();
    finishAudit(upstreamRes.statusCode ?? 101);
    // Reconstruct the 101 handshake byte-for-byte back to the client.
    try {
      clientSocket.write(formatHttpHead(upstreamRes));
      if (upstreamHead.length) clientSocket.write(upstreamHead);
    } catch {
      try { upstreamSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ }
      return;
    }
    // Bytes the client already sent after its handshake: forward them first, then pipe.
    if (clientHead.length) upstreamSocket.write(clientHead);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    const teardown = () => {
      try { upstreamSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ }
      try { clientSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ }
    };
    upstreamSocket.on('error', teardown);
    clientSocket.on('error', teardown);
    upstreamSocket.on('close', () => { try { clientSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ } });
    clientSocket.on('close', () => { try { upstreamSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ } });
  });

  // Upstream did not honor the upgrade (no 101): relay the regular response
  // back to the client and close — fail-closed with respect to the tunnel.
  upstreamReq.on('response', (upstreamRes) => {
    clearHandshakeTimer();
    finishAudit(upstreamRes.statusCode ?? null);
    try { clientSocket.write(formatHttpHead(upstreamRes)); } catch { /* best-effort: peer socket may already be closed */ }
    upstreamRes.on('data', (c: Buffer) => { try { clientSocket.write(c); } catch { /* best-effort: peer socket may already be closed */ } });
    upstreamRes.on('end', () => { try { clientSocket.end(); } catch { /* best-effort: peer socket may already be closed */ } });
    upstreamRes.on('error', () => { try { clientSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ } });
  });

  upstreamReq.on('error', () => { clearHandshakeTimer(); finishAudit(502); try { clientSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ } });
  clientSocket.on('error', () => { clearHandshakeTimer(); destroyUpstream(); });
  upstreamReq.end();
}

// Node validates request options synchronously in the ClientRequest constructor
// (e.g. ERR_UNESCAPED_CHARACTERS on an invalid request-target). Otherwise such a throw
// lands in the uncaughtException handler that takes down the whole process — and thus
// every huddle. Fail per request (400), not per process.
function tryCreateUpstreamRequest(
  create: () => http.ClientRequest,
  res: http.ServerResponse,
  complete: (resStatus: number | null) => void,
): http.ClientRequest | null {
  try {
    return create();
  } catch (err: any) {
    const body = JSON.stringify({ error: 'bad_request', message: `cannot forward request: ${err.message}` });
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    complete(400);
    return null;
  }
}

// Buffers and scrubs the OAuth token-exchange response so the real access_token
// never ends up in the audit log. Sends the scrubbed response to innerRes
// and calls complete with the safe audit body as the third argument.
function handleTokenExchangeResponse(
  upstreamRes: http.IncomingMessage,
  innerRes: http.ServerResponse,
  containerId: string | null,
  complete: (status: number | null, headers?: http.IncomingHttpHeaders, body?: string | null) => void,
): void {
  const chunks: Buffer[] = [];
  upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
  upstreamRes.on('end', () => {
    let outBuf: Buffer;
    let outHeaders = { ...upstreamRes.headers };
    // Fail-safe: log null on scrub errors instead of leaking the real token.
    let auditResBody: string | null = null;
    try {
      const rawBody = decodeBody(chunks, upstreamRes.headers);
      const json = rawBody ? JSON.parse(rawBody) : null;
      if (json?.access_token) {
        // Bind the placeholder to the requesting container (finding #12); no
        // 'unknown' fallback anymore. A null container yields a non-redeemable
        // placeholder (fail-closed).
        json.access_token = storeTokenExchange(containerId, json.access_token as string);
        // (No log line here: the audit entry below already records that an
        // exchange happened, with the placeholder value redacted.)
        outBuf = Buffer.from(JSON.stringify(json));
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = String(outBuf.length);
        // The placeholder is itself a redeemable bearer credential: redact it
        // from the audit body (finding #12) — the audit shows that an exchange
        // happened, not the usable value.
        auditResBody = cap(JSON.stringify({ ...json, access_token: '<redacted-placeholder>' }));
      } else {
        outBuf = Buffer.concat(chunks);
        outHeaders['content-length'] = String(outBuf.length);
        auditResBody = rawBody;
      }
    } catch {
      outBuf = Buffer.concat(chunks);
      outHeaders = { ...upstreamRes.headers };
    }
    innerRes.writeHead(upstreamRes.statusCode ?? 200, outHeaders);
    innerRes.end(outBuf);
    complete(upstreamRes.statusCode ?? null, outHeaders, auditResBody);
  });
  upstreamRes.on('error', () => {
    if (!innerRes.writableEnded) innerRes.destroy();
    complete(0, upstreamRes.headers);
  });
}

// `port` defaults to the fixed proxy port; tests bind on 0 (a free
// ephemeral port) so the path-forwarding behavior can be tested hermetically.
export function createProxyServer(port: number = PROXY_PORT): http.Server {
  const server = http.createServer();
  // Traffic on the dedicated sbx port comes from the sandbox FLEET. Huddle can't
  // attribute a live request to a specific box, so those requests are evaluated
  // against the MERGE of global + every sandbox's rules (checkFleetRule). sbx has
  // already enforced per-box before forwarding, so allow-if-any-sandbox-allows is
  // safe. See docs/ADR §5.
  const isSbxProxy = port === SBX_PROXY_PORT;
  // Rule evaluation for this server: per-container/global for the devcontainer
  // proxy; fleet-merge for the sbx proxy. For the fleet, PATH-MODE domains are
  // handled globally (sbx allows the domain in every sandbox; Huddle enforces the
  // paths here) — so the path is passed through.
  const evalRule = (host: string, containerId: string | null, path: string | null) =>
    isSbxProxy ? checkFleetRule(host, knownSandboxNames(), path) : checkRule(host, containerId, path);
  // OAuth token hiding is a DEVCONTAINER mechanism: it binds a placeholder to the
  // container that obtained it, and the sbx port has no such identity. sbx runs
  // its own proxy-managed credentials there anyway — see managesTokenExchange().
  const manageTokens = managesTokenExchange(isSbxProxy);

  server.on('request', async (req, res) => {
    // Extension server-side fetch is identified via the X-Huddle-Ext header
    const extHeader = req.headers['x-huddle-ext'];
    const containerId = extHeader
      ? `ext:${String(extHeader).replace(/[^a-z0-9-]/g, '')}`
      : await resolveContainerByIp(req.socket.remoteAddress ?? '');
    logIdentityProbe('request', req, req.socket.remoteAddress, containerId);
    const rawUrl = req.url || '';

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      send502(res, 'invalid target url');
      return;
    }

    // Canonicalize the host once at the edge into the form on which we match,
    // log and dial — so the checked and the sent host cannot
    // diverge (parser-differential, finding #3 + tail).
    const host = canonicalizeHost(target.hostname);
    if (host === null) {
      send502(res, 'invalid target host');
      return;
    }

    // Decide on the decoded form (normalizePathname, finding #7) but
    // forward the original encoded bytes from the URL parser. The decoded
    // form is not a valid request-target: raw spaces/UTF-8 make
    // http.request throw synchronously (ERR_UNESCAPED_CHARACTERS → process crash),
    // and the upstream would decode it a second time (double-decode
    // differential; also mangles legitimate %2F/%20). `new URL` has
    // already folded away `../`; normalizePathname covers `%2f`-disguised traversal
    // and rejects fail-closed — so `..` bytes never reach the upstream.
    const normPath = normalizePathname(target.pathname);
    if (normPath === null) {
      logAudit({
        containerId, domain: host, action: 'deny', ruleId: null,
        method: req.method ?? null, path: `${target.pathname}${target.search}`, resStatus: 403,
      });
      send403(res, host, 'deny', containerId);
      return;
    }
    const forwardPath = `${target.pathname}${target.search}`;

    let ruleId: number | null;
    if (host === 'huddle') {
      // Self-traffic: devcontainers may only reach a fixed set of huddle paths.
      const allowed =
        (target.port === '3000' && req.method === 'POST' && normPath === '/api/audit/sudo');
      if (!allowed) {
        logAudit({
          containerId,
          domain: 'huddle',
          action: 'deny',
          ruleId: null,
          method: req.method ?? null,
          path: forwardPath,
          resStatus: 403,
        });
        send403(res, 'huddle', 'deny', containerId);
        return;
      }
      ruleId = null;
    } else {
      const result = evalRule(host, containerId, normPath);
      if (result.status !== 'allow') {
        logAudit({
          containerId,
          domain: host,
          action: result.status,
          ruleId: null,
          method: req.method ?? null,
          path: forwardPath,
          resStatus: 403,
        });
        send403(res, host, result.status, containerId);
        return;
      }
      ruleId = result.ruleId;
    }

    const outgoingHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    delete outgoingHeaders['proxy-connection'];

    const reqChunks: Buffer[] = [];
    let reqBytes = 0;
    const resChunks: Buffer[] = [];
    let resBytes = 0;

    // Same in-flight approach as the MITM path: log the request immediately, fill in the
    // response (and the full req_body) as soon as upstream completes.
    const auditId = logAudit({
      containerId,
      domain: host,
      action: 'allow',
      ruleId,
      method: req.method ?? null,
      path: forwardPath,
      reqHeaders: headersToJson(req.headers),
    });
    let completed = false;
    const complete = (resStatus: number | null, resHeaders?: http.IncomingHttpHeaders) => {
      if (completed) return;
      completed = true;
      if (auditId == null) return;
      updateAuditResponse(auditId, {
        reqBody: reqBytes > 0 ? cap(Buffer.concat(reqChunks).toString('utf8')) : null,
        resStatus,
        resHeaders: resHeaders ? headersToJson(resHeaders as Record<string, any>) : null,
        resBody: resBytes > 0 ? decodeBody(resChunks, resHeaders ?? {}) : null,
      });
    };

    // MCP traffic to huddle always via the API port (3000), not the proxy port (80).
    const upstreamPort = target.port || 80;

    const upstream = tryCreateUpstreamRequest(() => http.request(
      {
        hostname: host,
        port: upstreamPort,
        method: req.method,
        path: forwardPath,
        headers: outgoingHeaders,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, sanitizeResHeaders(upstreamRes.headers));
        upstreamRes.on('data', (chunk: Buffer) => {
          if (!res.writableEnded) res.write(chunk);
          if (resBytes < CAP) { resChunks.push(chunk); resBytes += chunk.length; }
        });
        upstreamRes.on('end', () => {
          if (!res.writableEnded) res.end();
          complete(upstreamRes.statusCode ?? null, upstreamRes.headers);
        });
        upstreamRes.on('error', () => {
          if (!res.writableEnded) res.destroy();
          complete(0, upstreamRes.headers);
        });
      }
    ), res, complete);
    if (!upstream) return;

    upstream.on('error', (err) => {
      if (!res.headersSent) send502(res, err.message);
      complete(502);
    });

    req.on('error', () => upstream.destroy());
    req.on('data', (chunk: Buffer) => {
      upstream.write(chunk);
      if (reqBytes < CAP) { reqChunks.push(chunk); reqBytes += chunk.length; }
    });
    req.on('end', () => upstream.end());
  });

  // WebSocket (`ws://`) over the plain-HTTP path: a forward-proxy client sends
  // the upgrade handshake in absolute form (`GET http://host/path`) with
  // `Upgrade: websocket`. Node emits it as 'upgrade' (not 'request'); without
  // this handler Node would close the socket and time out the handshake. Same
  // firewall enforcement as the request path: canonicalize the host, decide on the
  // normalized path, forward the original encoded bytes.
  server.on('upgrade', async (req, clientSocket, head) => {
    const extHeader = req.headers['x-huddle-ext'];
    const containerId = extHeader
      ? `ext:${String(extHeader).replace(/[^a-z0-9-]/g, '')}`
      : await resolveContainerByIp(req.socket.remoteAddress ?? '');
    logIdentityProbe('upgrade', req, req.socket.remoteAddress, containerId);
    const rawUrl = req.url || '';

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      rejectSocket(clientSocket, 400, 'deny', '', containerId);
      return;
    }

    const host = canonicalizeHost(target.hostname);
    if (host === null) {
      rejectSocket(clientSocket, 400, 'deny', '', containerId);
      return;
    }

    const normPath = normalizePathname(target.pathname);
    if (normPath === null) {
      logAudit({
        containerId, domain: host, action: 'deny', ruleId: null,
        method: req.method ?? null, path: `${target.pathname}${target.search}`, resStatus: 403,
      });
      rejectSocket(clientSocket, 403, 'deny', host, containerId);
      return;
    }
    const forwardPath = `${target.pathname}${target.search}`;

    // Only a genuine WebSocket handshake may use the raw upgrade path; a request
    // that merely carries Upgrade headers (e.g. POST to an OAuth token endpoint)
    // must fall through to nothing here, not bypass the request pipeline/scrubbing.
    if (!isWebSocketHandshake(req.method, req.headers)) {
      logAudit({
        containerId, domain: host, action: 'deny', ruleId: null,
        method: req.method ?? null, path: forwardPath, resStatus: 400,
      });
      rejectSocket(clientSocket, 400, 'deny', host, containerId);
      return;
    }

    // No legitimate WebSocket endpoint on huddle itself → always fail-closed.
    if (host === 'huddle') {
      logAudit({
        containerId, domain: 'huddle', action: 'deny', ruleId: null,
        method: req.method ?? null, path: forwardPath, resStatus: 403,
      });
      rejectSocket(clientSocket, 403, 'deny', 'huddle', containerId);
      return;
    }

    const result = evalRule(host, containerId, normPath);
    if (result.status !== 'allow') {
      logAudit({
        containerId, domain: host, action: result.status, ruleId: null,
        method: req.method ?? null, path: forwardPath, resStatus: 403,
      });
      rejectSocket(clientSocket, 403, result.status, host, containerId);
      return;
    }

    const auditId = logAudit({
      containerId, domain: host, action: 'allow', ruleId: result.ruleId,
      method: req.method ?? null, path: forwardPath, reqHeaders: auditReqHeaders(req.headers),
    });

    const outgoingHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    stripProxyHeaders(outgoingHeaders);
    const upstreamPort = target.port || 80;
    forwardUpgrade(
      false,
      { hostname: host, port: upstreamPort, method: req.method, path: forwardPath, headers: outgoingHeaders },
      clientSocket,
      head,
      auditId,
    );
  });

  server.on('connect', async (req, clientSocket, head) => {
    const remoteAddress = (clientSocket as net.Socket).remoteAddress ?? '';
    const containerId = await resolveContainerByIp(remoteAddress);
    logIdentityProbe('connect', req, remoteAddress, containerId);
    const [rawHostname, portStr] = (req.url || '').split(':');
    const port = Number(portStr) || 443;

    // Canonicalize the CONNECT host the same way as the plain-HTTP path
    // (`new URL().hostname`) so both paths match, log, generate the cert and
    // dial on a single canonical form. Without this a capitalized host
    // (`GIST.GITHUB.COM`) would bypass an exact deny rule while
    // the wildcard-allow did match (finding #3).
    const hostname = canonicalizeHost(rawHostname);
    if (!hostname) {
      rejectSocket(clientSocket, 400, 'deny', '', null);
      return;
    }

    if (hostname === 'huddle') {
      // No HTTPS endpoint on huddle's own API — always reject CONNECT to self.
      logAudit({
        containerId,
        domain: 'huddle',
        port,
        action: 'deny',
        ruleId: null,
        method: 'CONNECT',
        resStatus: 403,
      });
      rejectSocket(clientSocket, 403, 'deny', 'huddle', containerId);
      return;
    }
    const { status, ruleId } = evalRule(hostname, containerId, null);
    // Path-allowlist domains are closed at the host level, but the CONNECT tunnel
    // must be open so that MITM sees the path after TLS termination and can enforce
    // per request (see the innerHttp handler). Only meaningful if we can
    // inspect: 443 + not cert-pinned. Otherwise it stays closed host-only.
    const pathModeTunnel =
      status !== 'allow' &&
      port === 443 &&
      !NO_INTERCEPT_DOMAINS.has(hostname.toLowerCase()) &&
      isPathMode(hostname, containerId);
    if (status !== 'allow' && !pathModeTunnel) {
      logAudit({
        containerId,
        domain: hostname,
        port,
        action: status,
        ruleId: null,
        method: 'CONNECT',
        resStatus: 403,
      });
      rejectSocket(clientSocket, 403, status, hostname, containerId);
      return;
    }

    // Domains with cert-pinning cannot go through MITM. For those domains
    // we fall back to the old raw TCP tunnel; request/response content
    // then stays invisible in the audit log (only CONNECT recorded).
    if (NO_INTERCEPT_DOMAINS.has(hostname.toLowerCase()) || port !== 443) {
      const upstream = net.connect(port, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        logAudit({
          containerId,
          domain: hostname,
          port,
          action: 'allow',
          ruleId,
          method: 'CONNECT',
          resStatus: 200,
        });
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket, { end: false });
        clientSocket.pipe(upstream, { end: false });
        upstream.on('end', () => clientSocket.destroy());
        clientSocket.on('end', () => upstream.destroy());
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      return;
    }

    // MITM path: present a dynamically generated leaf cert to the client,
    // terminate TLS, parse HTTP and forward to upstream over a real TLS
    // connection. All req/res headers and bodies end up in the audit log.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    logAudit({
      containerId,
      domain: hostname,
      port,
      action: 'allow',
      ruleId,
      method: 'CONNECT',
      resStatus: 200,
    });

    let leaf: { certPem: string; keyPem: string };
    try {
      leaf = signLeafCert(hostname);
    } catch (err: any) {
      console.warn(`[proxy-mitm] leaf cert generation failed for ${hostname}:`, err.message);
      clientSocket.destroy();
      return;
    }

    const innerTls = new tls.TLSSocket(clientSocket, {
      isServer: true,
      cert: leaf.certPem,
      key: leaf.keyPem,
      ALPNProtocols: ['http/1.1'],
    });
    innerTls.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNRESET and self-signed-rejected are normal if the container
      // does not yet trust the CA — log once and close cleanly.
      if (err.code !== 'ECONNRESET') {
        console.warn(`[proxy-mitm] inner TLS error (${hostname}):`, err.message);
      }
      try { clientSocket.destroy(); } catch { /* best-effort: peer socket may already be closed */ }
    });
    if (head && head.length) innerTls.unshift(head);

    // One lightweight http.Server per CONNECT that reads the wrapped TLS socket.
    const innerHttp = http.createServer();
    innerHttp.on('request', (innerReq, innerRes) => {
      // The CONNECT already allowed the host (the path was encrypted then). Now that TLS
      // is terminated we know the path: apply path policy per request after all.
      //
      // Decide on the decoded form (finding #7): traversal (`../`, `..%2f`)
      // or broken encoding → fail closed (403), never forward. Forwarded
      // afterwards are the original encoded bytes (see rules.ts): the decoded
      // form is not a valid request-target — raw spaces/UTF-8 (e.g. a
      // `%20` in an Azure DevOps project name) make https.request throw
      // synchronously (ERR_UNESCAPED_CHARACTERS → process crash) — and the upstream would
      // decode it a second time, whereby `%252e%252e` still decays to `..`
      // and legitimate %2F/%20 get mangled.
      const rawUrl = innerReq.url ?? '/';
      const qi = rawUrl.indexOf('?');
      const rawPathPart = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
      const query = qi === -1 ? '' : rawUrl.slice(qi);
      const normPath = normalizePathname(rawPathPart);
      const checkUrl = normPath === null ? null : `${normPath}${query}`;

      const pathResult = normPath === null
        ? { status: 'deny' as const, ruleId: null }
        : evalRule(hostname, containerId, checkUrl);
      // Block everything except 'allow': a 'deny' path rule, but also a not-yet-
      // reviewed subpath ('requested') of a path-allowlist domain —
      // fail-closed until the operator explicitly allows the path.
      if (pathResult.status !== 'allow') {
        logAudit({
          containerId,
          domain: hostname,
          port,
          action: pathResult.status,
          ruleId: pathResult.ruleId,
          method: innerReq.method ?? null,
          path: innerReq.url ?? null,
          reqHeaders: headersToJson(innerReq.headers),
          resStatus: 403,
        });
        const blockedBody = JSON.stringify({
          error: 'REQUEST_BLOCKED_BY_HUDDLE',
          message: 'This request path is blocked by Huddle security policy.',
          blockedEndpoint: `${hostname}${innerReq.url ?? ''}`,
          reason: pathResult.status === 'requested'
            ? 'This path has not yet been approved for this devcontainer.'
            : 'This path is denied by a firewall rule.',
          actionRequired: 'The user must approve this path in the Huddle portal (http://huddle:3000) before this request can continue.',
          devcontainerId: containerId ?? undefined,
          huddlePortal: 'http://localhost:3000',
        });
        innerRes.writeHead(403, {
          'content-type': 'application/json',
          'x-huddle-blocked': '1',
          'content-length': Buffer.byteLength(blockedBody),
        });
        innerRes.end(blockedBody);
        return;
      }

      const upstreamHeaders = { ...innerReq.headers };
      delete upstreamHeaders['proxy-connection'];

      // Token replacement: replace placeholder with the real token for
      // api.anthropic.com. Skipped in sbx mode — sbx manages the credential
      // itself (the sandbox holds `sk-ant-oat01-proxy-managed`), so a second
      // rewriter would only fight it. See managesTokenExchange().
      if (manageTokens && hostname === 'api.anthropic.com') {
        const authVal = upstreamHeaders['authorization'] as string | undefined;
        if (authVal?.startsWith('Bearer ') && isPlaceholderToken(authVal.slice(7))) {
          // Only redeem if this container also received the placeholder (#12).
          const real = resolveToken(authVal.slice(7), containerId);
          if (real) upstreamHeaders['authorization'] = `Bearer ${real}`;
        }
        const apiKey = upstreamHeaders['x-api-key'] as string | undefined;
        if (apiKey && isPlaceholderToken(apiKey)) {
          const real = resolveToken(apiKey, containerId);
          if (real) upstreamHeaders['x-api-key'] = real;
        }
      }

      // Token exchange: detect OAuth token response from platform.claude.com
      const isTokenRequest =
        manageTokens &&
        hostname === 'platform.claude.com' &&
        innerReq.method === 'POST' &&
        (innerReq.url?.split('?')[0] ?? '') === '/v1/oauth/token';

      const reqChunks: Buffer[] = [];
      let reqBytes = 0;
      const resChunks: Buffer[] = [];
      let resBytes = 0;

      // Log the request immediately (method/path/headers) so the call appears in the audit
      // log as soon as it comes in — res_status stays NULL ("in-flight")
      // until the upstream response completes. Crucial for streaming responses (e.g.
      // Anthropic SSE) that stay open for seconds to minutes: without this the
      // whole call would be invisible until it finishes.
      const auditId = logAudit({
        containerId,
        domain: hostname,
        port,
        action: 'allow',
        ruleId,
        method: innerReq.method ?? null,
        path: innerReq.url ?? null,
        reqHeaders: headersToJson(innerReq.headers),
      });
      let completed = false;
      // resBody: pass explicitly for scrubbed paths (token-exchange) so the
      // real secret never ends up in the audit log. Omit = derive from resChunks.
      const complete = (resStatus: number | null, resHeaders?: http.IncomingHttpHeaders, resBody?: string | null) => {
        if (completed) return;
        completed = true;
        if (auditId == null) return;
        updateAuditResponse(auditId, {
          reqBody: reqBytes > 0 ? cap(Buffer.concat(reqChunks).toString('utf8')) : null,
          resStatus,
          resHeaders: resHeaders ? headersToJson(resHeaders as Record<string, any>) : null,
          resBody: resBody !== undefined ? resBody : resBytes > 0 ? decodeBody(resChunks, resHeaders ?? {}) : null,
        });
      };

      const upstreamReq = tryCreateUpstreamRequest(() => https.request(
        {
          hostname,
          port,
          method: innerReq.method,
          // The original encoded bytes; the decoded checkUrl is only the
          // decision form. Traversal was already fail-closed rejected above.
          path: rawUrl,
          headers: upstreamHeaders,
          servername: hostname,
        },
        (upstreamRes) => {
          if (isTokenRequest && upstreamRes.statusCode === 200) {
            handleTokenExchangeResponse(upstreamRes, innerRes, containerId, complete);
          } else {
            innerRes.writeHead(upstreamRes.statusCode || 502, sanitizeResHeaders(upstreamRes.headers));
            upstreamRes.on('data', (chunk: Buffer) => {
              if (!innerRes.writableEnded) innerRes.write(chunk);
              if (resBytes < CAP) { resChunks.push(chunk); resBytes += chunk.length; }
            });
            upstreamRes.on('end', () => {
              if (!innerRes.writableEnded) innerRes.end();
              complete(upstreamRes.statusCode ?? null, upstreamRes.headers);
            });
            upstreamRes.on('error', () => {
              if (!innerRes.writableEnded) innerRes.destroy();
              complete(0, upstreamRes.headers);
            });
          }
        },
      ), innerRes, complete);
      if (!upstreamReq) return;

      upstreamReq.on('error', (err) => {
        if (!innerRes.headersSent) {
          try {
            innerRes.writeHead(502, { 'content-type': 'application/json' });
            innerRes.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
          } catch { /* best-effort: peer socket may already be closed */ }
        }
        complete(502);
      });

      innerReq.on('data', (chunk: Buffer) => {
        upstreamReq.write(chunk);
        if (reqBytes < CAP) { reqChunks.push(chunk); reqBytes += chunk.length; }
      });
      innerReq.on('end', () => upstreamReq.end());
      innerReq.on('error', () => upstreamReq.destroy());
    });
    // WebSocket (`wss://`) after TLS termination: the client sends the upgrade
    // handshake over the wrapped TLS socket. Node emits it as a SEPARATE
    // 'upgrade' event (not 'request'); without this handler Node closes the socket
    // and times out the handshake — exactly the Codex CLI delay from #74. Same
    // path enforcement as the request handler above: decide on the decoded
    // form, forward the original encoded bytes.
    innerHttp.on('upgrade', (innerReq, innerSocket, innerHead) => {
      // Only a genuine WebSocket handshake may take the raw upgrade path. A
      // non-WS "upgrade" (e.g. POST /v1/oauth/token with Upgrade: websocket)
      // would otherwise be forwarded verbatim and skip handleTokenExchangeResponse,
      // leaking the real bearer token to the container. Fail closed.
      if (!isWebSocketHandshake(innerReq.method, innerReq.headers)) {
        logAudit({
          containerId, domain: hostname, port, action: 'deny', ruleId: null,
          method: innerReq.method ?? null, path: innerReq.url ?? null, resStatus: 400,
        });
        rejectSocket(innerSocket, 400, 'deny', hostname, containerId);
        return;
      }
      const rawUrl = innerReq.url ?? '/';
      const qi = rawUrl.indexOf('?');
      const rawPathPart = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
      const query = qi === -1 ? '' : rawUrl.slice(qi);
      const normPath = normalizePathname(rawPathPart);
      const checkUrl = normPath === null ? null : `${normPath}${query}`;

      const pathResult = normPath === null
        ? { status: 'deny' as const, ruleId: null }
        : evalRule(hostname, containerId, checkUrl);
      if (pathResult.status !== 'allow') {
        logAudit({
          containerId,
          domain: hostname,
          port,
          action: pathResult.status,
          ruleId: pathResult.ruleId,
          method: innerReq.method ?? null,
          path: innerReq.url ?? null,
          reqHeaders: headersToJson(innerReq.headers),
          resStatus: 403,
        });
        rejectSocket(innerSocket, 403, pathResult.status, hostname, containerId);
        return;
      }

      const auditId = logAudit({
        containerId,
        domain: hostname,
        port,
        action: 'allow',
        ruleId: pathResult.ruleId,
        method: innerReq.method ?? null,
        path: innerReq.url ?? null,
        reqHeaders: auditReqHeaders(innerReq.headers),
      });

      const upstreamHeaders = { ...innerReq.headers };
      stripProxyHeaders(upstreamHeaders);
      forwardUpgrade(
        true,
        {
          hostname,
          port,
          method: innerReq.method,
          // Original encoded bytes; checkUrl was only the decision form.
          path: rawUrl,
          headers: upstreamHeaders,
          servername: hostname,
        },
        innerSocket,
        innerHead,
        auditId,
      );
    });
    innerHttp.on('clientError', (_err, sock) => { try { sock.destroy(); } catch { /* best-effort: peer socket may already be closed */ } });

    innerHttp.emit('connection', innerTls);

    clientSocket.on('close', () => { try { innerTls.destroy(); } catch { /* best-effort: peer socket may already be closed */ } });
  });

  server.listen(port, () => {
    console.log(`[proxy] listening on :${port}`);
  });

  return server;
}
