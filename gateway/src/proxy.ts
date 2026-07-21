import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import stream from 'stream';
import zlib from 'zlib';
import { URL } from 'url';
import { checkRule, isPathMode, canonicalizeHost, normalizePathname } from './rules';
import { resolveContainerByIp } from './docker';
import { logAudit, updateAuditResponse } from './db';
import { signLeafCert } from './tls-ca';
import { storeTokenExchange, resolveToken, isPlaceholderToken } from './token-exchange';

const PROXY_PORT = 80;

// Domains die de MITM overslaan (raw TCP-tunnel houden). Voor clients met
// cert-pinning (npm registry, sommige Java libs) is MITM een breaker.
const NO_INTERCEPT_DOMAINS: Set<string> = new Set(
  (process.env.NO_INTERCEPT_DOMAINS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
);

const CAP = 20 * 1024; // 20 KB per field
function cap(s: string): string { return s.length > CAP ? s.slice(0, CAP) + '\n[truncated]' : s; }
function headersToJson(h: Record<string, any>): string { try { return cap(JSON.stringify(h)); } catch { return '{}'; } }

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
    return '[binary / niet decodeerbaar]';
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

function rejectSocket(socket: stream.Duplex, status: number, blockStatus: string, domain: string, containerId?: string | null): void {
  const body = JSON.stringify({
    error: 'REQUEST_BLOCKED_BY_HUDDLE',
    message: 'This CONNECT request is blocked by Huddle security policy.',
    blockedEndpoint: domain,
    reason: blockStatus === 'requested'
      ? 'This endpoint has not yet been approved for this devcontainer.'
      : 'This endpoint is denied by a firewall rule.',
    actionRequired: 'The user must approve this endpoint in the Huddle portal (http://huddle:3000) before this request can continue.',
    devcontainerId: containerId ?? undefined,
    huddlePortal: 'http://localhost:3000',
  });
  socket.write(
    `HTTP/1.1 ${status} Forbidden\r\n` +
      `content-type: application/json\r\n` +
      `x-huddle-blocked: 1\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n` +
      body
  );
  socket.end();
}

// Node valideert request-opties synchroon in de ClientRequest-constructor
// (bv. ERR_UNESCAPED_CHARACTERS bij een ongeldige request-target). Zo'n throw
// belandt anders in de uncaughtException-handler die het hele proces — en dus
// élke huddle — neerhaalt. Fail per request (400), niet per proces.
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

// Buffers en scrubt de OAuth token-exchange response zodat het echte access_token
// nooit in de audit-log terechtkomt. Stuurt de gescrubde response naar innerRes
// en roept complete aan met de veilige audit-body als derde argument.
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
    // Fail-safe: log null bij scrub-fouten i.p.v. het echte token te lekken.
    let auditResBody: string | null = null;
    try {
      const rawBody = decodeBody(chunks, upstreamRes.headers);
      const json = rawBody ? JSON.parse(rawBody) : null;
      if (json?.access_token) {
        // Bind de placeholder aan de aanvragende container (finding #12); geen
        // 'unknown'-fallback meer. Een null container levert een niet-inwissel-
        // bare placeholder op (fail-closed).
        json.access_token = storeTokenExchange(containerId, json.access_token as string);
        console.log(`[token-exchange] placeholder issued voor container ${containerId}`);
        outBuf = Buffer.from(JSON.stringify(json));
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = String(outBuf.length);
        // De placeholder is zelf een inwisselbare bearer-credential: redact hem
        // uit de audit-body (finding #12) — de audit toont dat er een exchange
        // was, niet de bruikbare waarde.
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

// `port` is standaard de vaste proxypoort; tests binden op 0 (een vrije
// efemere poort) zodat het pad-forwardgedrag hermetisch getest kan worden.
export function createProxyServer(port: number = PROXY_PORT): http.Server {
  const server = http.createServer();

  server.on('request', async (req, res) => {
    // Extension server-side fetch wordt geïdentificeerd via X-Huddle-Ext header
    const extHeader = req.headers['x-huddle-ext'];
    const containerId = extHeader
      ? `ext:${String(extHeader).replace(/[^a-z0-9-]/g, '')}`
      : await resolveContainerByIp(req.socket.remoteAddress ?? '');
    const rawUrl = req.url || '';

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      send502(res, 'invalid target url');
      return;
    }

    // Canoniseer de host één keer aan de rand naar de vorm waarop we matchen,
    // loggen én dialen — zodat de gecontroleerde en de verstuurde host niet
    // kunnen divergeren (parser-differential, finding #3 + staart).
    const host = canonicalizeHost(target.hostname);
    if (host === null) {
      send502(res, 'invalid target host');
      return;
    }

    // Beslis op de gedecodeerde vorm (normalizePathname, finding #7) maar
    // forward de originele encoded bytes van de URL-parser. De gedecodeerde
    // vorm is geen geldige request-target: rauwe spaties/UTF-8 laten
    // http.request synchroon gooien (ERR_UNESCAPED_CHARACTERS → proces-crash),
    // en de upstream zou hem een twééde keer decoden (double-decode-
    // differential; verminkt bovendien legitieme %2F/%20). `new URL` heeft
    // `../` al weggevouwen; normalizePathname dekt `%2f`-getruceerde traversal
    // en weigert fail-closed — er bereiken dus nooit `..`-bytes de upstream.
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
      const result = checkRule(host, containerId, normPath);
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

    // Zelfde in-flight-aanpak als het MITM-pad: log de request meteen, vul de
    // response (en de volledige req_body) bij zodra upstream afrondt.
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

    // MCP-verkeer naar huddle altijd via de API-poort (3000), niet de proxypoort (80).
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

  server.on('connect', async (req, clientSocket, head) => {
    const containerId = await resolveContainerByIp(
      (clientSocket as net.Socket).remoteAddress ?? ''
    );
    const [rawHostname, portStr] = (req.url || '').split(':');
    const port = Number(portStr) || 443;

    // Canoniseer de CONNECT-host op dezelfde manier als het plain-HTTP-pad
    // (`new URL().hostname`) zodat beide paden op één canonieke vorm matchen,
    // loggen, het cert genereren en dialen. Zonder dit omzeilde een
    // ge-kapitaliseerde host (`GIST.GITHUB.COM`) een exacte deny-regel terwijl
    // de wildcard-allow wél matchte (finding #3).
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
    const { status, ruleId } = checkRule(hostname, containerId, null);
    // Pad-allowlist domeinen staan op host-niveau dicht, maar de CONNECT-tunnel
    // moet wél open zodat MITM ná TLS-terminatie het pad ziet en per request kan
    // handhaven (zie de innerHttp-handler). Alleen zinvol als we kúnnen
    // inspecteren: 443 + niet cert-pinned. Anders blijft het host-only dicht.
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

    // Domeinen met cert-pinning kunnen niet door MITM. Voor die domeinen
    // vallen we terug op de oude raw TCP-tunnel; request/response inhoud
    // blijft dan onzichtbaar in de audit log (alleen CONNECT geregistreerd).
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

    // MITM-pad: presenteer een dynamisch gegenereerd leaf-cert aan de client,
    // termineer TLS, parse HTTP en forward naar upstream over een echte TLS-
    // verbinding. Alle req/res-headers en bodies belanden in de audit log.
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
      // ECONNRESET en self-signed-rejected zijn normaal als de container
      // de CA nog niet vertrouwt — log één keer en sluit netjes.
      if (err.code !== 'ECONNRESET') {
        console.warn(`[proxy-mitm] inner TLS error (${hostname}):`, err.message);
      }
      try { clientSocket.destroy(); } catch {}
    });
    if (head && head.length) innerTls.unshift(head);

    // Per CONNECT één lichtgewicht http.Server die de gewrapte TLS-socket leest.
    const innerHttp = http.createServer();
    innerHttp.on('request', (innerReq, innerRes) => {
      // De CONNECT stond de host al toe (pad was toen versleuteld). Nu de TLS
      // getermineerd is kennen we het pad: pas padbeleid alsnog toe per request.
      //
      // Beslis op de gedecodeerde vorm (finding #7): traversal (`../`, `..%2f`)
      // of kapotte encoding → fail closed (403), nooit doorsturen. Geforward
      // worden daarna de originele encoded bytes (zie rules.ts): de gedecodeerde
      // vorm is geen geldige request-target — rauwe spaties/UTF-8 (bv. een
      // `%20` in een Azure DevOps-projectnaam) laten https.request synchroon
      // gooien (ERR_UNESCAPED_CHARACTERS → proces-crash) — en de upstream zou
      // hem een twééde keer decoden, waarmee `%252e%252e` alsnog tot `..`
      // vervalt en legitieme %2F/%20 verminkt raken.
      const rawUrl = innerReq.url ?? '/';
      const qi = rawUrl.indexOf('?');
      const rawPathPart = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
      const query = qi === -1 ? '' : rawUrl.slice(qi);
      const normPath = normalizePathname(rawPathPart);
      const checkUrl = normPath === null ? null : `${normPath}${query}`;

      const pathResult = normPath === null
        ? { status: 'deny' as const, ruleId: null }
        : checkRule(hostname, containerId, checkUrl);
      // Alles behalve 'allow' blokkeren: een 'deny'-padregel, maar ook een nog
      // niet beoordeeld subpad ('requested') van een pad-allowlist-domein —
      // fail-closed tot de operator het pad expliciet toestaat.
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

      // Token replacement: vervang placeholder door het echte token voor api.anthropic.com
      if (hostname === 'api.anthropic.com') {
        const authVal = upstreamHeaders['authorization'] as string | undefined;
        if (authVal?.startsWith('Bearer ') && isPlaceholderToken(authVal.slice(7))) {
          // Alleen inwisselen als deze container de placeholder ook kreeg (#12).
          const real = resolveToken(authVal.slice(7), containerId);
          if (real) upstreamHeaders['authorization'] = `Bearer ${real}`;
        }
        const apiKey = upstreamHeaders['x-api-key'] as string | undefined;
        if (apiKey && isPlaceholderToken(apiKey)) {
          const real = resolveToken(apiKey, containerId);
          if (real) upstreamHeaders['x-api-key'] = real;
        }
      }

      // Token exchange: detecteer OAuth token response van platform.claude.com
      const isTokenRequest =
        hostname === 'platform.claude.com' &&
        innerReq.method === 'POST' &&
        (innerReq.url?.split('?')[0] ?? '') === '/v1/oauth/token';

      const reqChunks: Buffer[] = [];
      let reqBytes = 0;
      const resChunks: Buffer[] = [];
      let resBytes = 0;

      // Log de request meteen (method/path/headers) zodat de call al in de audit
      // log verschijnt zodra hij binnenkomt — res_status blijft NULL ("in-flight")
      // tot de upstream-response afrondt. Cruciaal voor streaming responses (bv.
      // Anthropic SSE) die seconden tot minuten open blijven: zonder dit zou de
      // hele call onzichtbaar zijn tot hij klaar is.
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
      // resBody: expliciet meegeven voor gescrubde paden (token-exchange) zodat het
      // echte secret nooit in de audit-log terechtkomt. Weglaten = afleiden uit resChunks.
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
          // De originele encoded bytes; de gedecodeerde checkUrl is alleen de
          // beslisvorm. Traversal is hierboven al fail-closed geweigerd.
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
          } catch {}
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
    innerHttp.on('clientError', (_err, sock) => { try { sock.destroy(); } catch {} });

    innerHttp.emit('connection', innerTls);

    clientSocket.on('close', () => { try { innerTls.destroy(); } catch {} });
  });

  server.listen(port, () => {
    console.log(`[proxy] listening on :${port}`);
  });

  return server;
}
