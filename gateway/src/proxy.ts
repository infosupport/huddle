import http from 'http';
import net from 'net';
import stream from 'stream';
import { URL } from 'url';
import { checkRule } from './rules';
import { resolveContainerByIp } from './docker';
import { logAudit } from './db';

const PROXY_PORT = 80;

const CAP = 20 * 1024; // 20 KB per field
function cap(s: string): string { return s.length > CAP ? s.slice(0, CAP) + '\n[truncated]' : s; }
function headersToJson(h: Record<string, any>): string { try { return cap(JSON.stringify(h)); } catch { return '{}'; } }

function send403(res: http.ServerResponse, domain: string, reason: string): void {
  const body = JSON.stringify({ error: 'forbidden', domain, reason });
  res.writeHead(403, {
    'content-type': 'application/json',
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

function rejectSocket(socket: stream.Duplex, status: number, reason: string): void {
  const body = JSON.stringify({ error: 'forbidden', reason });
  socket.write(
    `HTTP/1.1 ${status} Forbidden\r\n` +
      `content-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n` +
      body
  );
  socket.end();
}

export function createProxyServer(): http.Server {
  const server = http.createServer();

  server.on('request', async (req, res) => {
    const containerId = await resolveContainerByIp(req.socket.remoteAddress ?? '');
    const rawUrl = req.url || '';

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      send502(res, 'invalid target url');
      return;
    }

    let ruleId: number | null;
    if (target.hostname === 'huddle') {
      // Self-traffic: devcontainers may only reach a fixed set of huddle paths.
      const allowed =
        target.port === '3000' &&
        req.method === 'POST' &&
        target.pathname === '/api/audit/sudo';
      if (!allowed) {
        logAudit({
          containerId,
          domain: 'huddle',
          action: 'deny',
          ruleId: null,
          method: req.method ?? null,
          path: `${target.pathname}${target.search}`,
          resStatus: 403,
        });
        send403(res, 'huddle', 'huddle-internal endpoint not allowed');
        return;
      }
      ruleId = null;
    } else {
      const result = checkRule(target.hostname, containerId);
      if (result.status !== 'allow') {
        logAudit({
          containerId,
          domain: target.hostname,
          action: result.status,
          ruleId: null,
          method: req.method ?? null,
          path: `${target.pathname}${target.search}`,
          resStatus: 403,
        });
        send403(res, target.hostname, result.status);
        return;
      }
      ruleId = result.ruleId;
    }

    const outgoingHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    delete outgoingHeaders['proxy-connection'];

    const reqChunks: Buffer[] = [];
    let reqBytes = 0;

    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: outgoingHeaders,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        const resChunks: Buffer[] = [];
        let resBytes = 0;
        let logged = false;
        const doLog = (resStatus: number | null) => {
          if (logged) return;
          logged = true;
          const reqBuf = Buffer.concat(reqChunks).slice(0, CAP);
          const resBuf = Buffer.concat(resChunks).slice(0, CAP);
          logAudit({
            containerId,
            domain: target.hostname,
            action: 'allow',
            ruleId,
            method: req.method ?? null,
            path: `${target.pathname}${target.search}`,
            reqHeaders: headersToJson(req.headers),
            reqBody: reqBytes > 0 ? cap(reqBuf.toString('utf8')) : null,
            resStatus,
            resHeaders: headersToJson(upstreamRes.headers as Record<string, any>),
            resBody: resBytes > 0 ? cap(resBuf.toString('utf8')) : null,
          });
        };
        upstreamRes.on('data', (chunk: Buffer) => {
          if (!res.writableEnded) res.write(chunk);
          if (resBytes < CAP) { resChunks.push(chunk); resBytes += chunk.length; }
        });
        upstreamRes.on('end', () => {
          if (!res.writableEnded) res.end();
          doLog(upstreamRes.statusCode ?? null);
        });
        upstreamRes.on('error', () => {
          if (!res.writableEnded) res.destroy();
          doLog(0);
        });
      }
    );

    upstream.on('error', (err) => {
      if (!res.headersSent) send502(res, err.message);
      logAudit({
        containerId,
        domain: target.hostname,
        action: 'allow',
        ruleId,
        method: req.method ?? null,
        path: `${target.pathname}${target.search}`,
        resStatus: 502,
      });
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
    const [hostname, portStr] = (req.url || '').split(':');
    const port = Number(portStr) || 443;

    if (!hostname) {
      rejectSocket(clientSocket, 400, 'missing host');
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
      rejectSocket(clientSocket, 403, 'huddle-internal endpoint not allowed');
      return;
    }
    const { status, ruleId } = checkRule(hostname, containerId);
    if (status !== 'allow') {
      logAudit({
        containerId,
        domain: hostname,
        port,
        action: status,
        ruleId: null,
        method: 'CONNECT',
        resStatus: 403,
      });
      rejectSocket(clientSocket, 403, status);
      return;
    }

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
  });

  server.listen(PROXY_PORT, () => {
    console.log(`[proxy] listening on :${PROXY_PORT}`);
  });

  return server;
}
