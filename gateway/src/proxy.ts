import http from 'http';
import net from 'net';
import stream from 'stream';
import { URL } from 'url';
import { checkRule } from './rules';
import { resolveContainerByIp } from './docker';

const PROXY_PORT = 80;

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

    const status = checkRule(target.hostname, containerId);
    if (status !== 'allow') {
      send403(res, target.hostname, status);
      return;
    }

    const outgoingHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    delete outgoingHeaders['proxy-connection'];

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
        upstreamRes.pipe(res);
      }
    );

    upstream.on('error', (err) => {
      send502(res, err.message);
    });

    req.pipe(upstream);
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

    const status = checkRule(hostname, containerId);
    if (status !== 'allow') {
      rejectSocket(clientSocket, 403, status);
      return;
    }

    const upstream = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', () => {
      rejectSocket(clientSocket, 502, 'upstream connect failed');
    });

    clientSocket.on('error', () => {
      upstream.destroy();
    });
  });

  server.listen(PROXY_PORT, () => {
    console.log(`[proxy] listening on :${PROXY_PORT}`);
  });

  return server;
}
