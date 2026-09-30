// Kan de gateway zien WELKE sandbox belt?
//
// Een kale HTTP-proxy die niets handhaaft en alleen opschrijft wat er aankomt.
// Draai hem op de host, wijs sbx ernaar, en curl vanuit twee sandboxen. De vraag
// is niet of het verkeer aankomt — dat weten we — maar of er iets in zit dat de
// ene box van de andere onderscheidt.
//
//   node sbx-identity-probe.mjs [poort]        (default 32999)
//
// Alles stdlib: geen npm install, dus geen allowlist nodig.

import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.argv[2] ?? 32999);

function decode(auth) {
  if (!auth) return null;
  const [scheme, value] = String(auth).split(/\s+/, 2);
  if (!/^basic$/i.test(scheme) || !value) return String(auth);
  try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return String(auth); }
}

let n = 0;
function report(kind, target, socket, headers) {
  const auth = headers['proxy-authorization'];
  const extras = Object.entries(headers)
    .filter(([k]) => k.startsWith('x-') || k === 'user-agent' || k === 'proxy-connection')
    .map(([k, v]) => `${k}: ${v}`);
  console.log(`\n#${++n} ${kind} ${target}`);
  console.log(`   from        ${socket.remoteAddress}:${socket.remotePort}  →  local ${socket.localPort}`);
  console.log(`   proxy-auth  ${decode(auth) ?? '(none)'}`);
  for (const e of extras) console.log(`   ${e}`);
}

const server = http.createServer((req, res) => {
  report('HTTP   ', req.url, req.socket, req.headers);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('probe ok\n');
});

// CONNECT is de belangrijke: bijna al het echte verkeer is HTTPS, en identiteit
// die alleen op gewone requests zichtbaar is, is onbruikbaar.
server.on('connect', (req, clientSocket, head) => {
  report('CONNECT', req.url, clientSocket, req.headers);
  const [host, port] = req.url.split(':');
  const upstream = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const bail = () => { upstream.destroy(); clientSocket.destroy(); };
  upstream.on('error', bail);
  clientSocket.on('error', bail);
});

server.listen(PORT, () => {
  console.log(`probe luistert op http://localhost:${PORT} — wijs sbx hierheen en curl vanuit een sandbox`);
});
