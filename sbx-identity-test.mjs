// Kan de gateway zien WELKE sandbox belt?
//
// De hele vraag in één run. sbx' host-daemon termineert en herschrijft alles wat
// uit een doos komt, dus bronadres en headers zijn geen identiteit. Wat overblijft
// is de credential in de upstream-proxy-URL: die presenteert de daemon áán ons,
// en volgens de docs bakt sbx hem in bij `create`. Dit script controleert of dat
// echt zo is — en wat er bij een herstart gebeurt.
//
//   node sbx-identity-test.mjs [--port 32999] [--target URL] [--keep] [--no-restart]
//
// --target     waar de curl heen gaat; standaard https://example.com. Kies een
//              domein dat je gateway toestaat, anders meet je zijn blokkade.
// --keep       ruimt de testsandboxen niet op
// --no-restart slaat fase 4 over (de herstart-vraag)
//
// SBX_BIN wijst naar een andere sbx (of naar een stub, om het script zelf te
// beproeven zonder sandboxen aan te maken).
//
// Alles stdlib. De globale proxy-instelling wordt vóór de test gelezen en na
// afloop teruggezet, ook als er iets misgaat: het is één instelling voor je hele
// machine en die mag deze test niet achterlaten.

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const PORT = Number(val('--port', 32999));
const BOXES = [
  { name: 'huddle-probe-a', user: 'huddle-probe-a', pass: 'secret-a' },
  { name: 'huddle-probe-b', user: 'huddle-probe-b', pass: 'secret-b' },
];
const TARGET = val('--target', 'https://example.com');

// Zelfde ontsnapping als ops.ts (HUDDLE_SBX_BIN), zodat dit script tegen een stub
// gedraaid kan worden.
const SBX = process.env.SBX_BIN ?? 'sbx';

// ── de luisteraar ────────────────────────────────────────────────────────────
//
// Handhaaft niets. Noteert alleen welke credential er binnenkwam, onder het label
// van de fase die op dat moment loopt — daarom draaien de curls één voor één.

let phase = 'setup';
const hits = [];

function credentialOf(headers) {
  const raw = headers['proxy-authorization'];
  if (!raw) return null;
  const [scheme, value] = String(raw).split(/\s+/, 2);
  if (!/^basic$/i.test(scheme) || !value) return String(raw);
  try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return String(raw); }
}

function note(kind, target, socket, headers) {
  hits.push({ phase, kind, target, from: socket.remoteAddress, credential: credentialOf(headers) });
}

const server = http.createServer((req, res) => {
  note('HTTP', req.url, req.socket, req.headers);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('probe ok\n');
});

// CONNECT is de maatgevende: al het echte verkeer is HTTPS. We tunnelen door naar
// de echte host zodat curl in de doos ook werkelijk slaagt.
server.on('connect', (req, clientSocket, head) => {
  note('CONNECT', req.url, clientSocket, req.headers);
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

// ── sbx aanroepen ────────────────────────────────────────────────────────────

function sbx(argv, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(SBX, argv, { shell: process.platform === 'win32' });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    p.on('close', (code) => {
      if (!quiet && code !== 0) console.log(`   ! ${SBX} ${argv.join(' ')} → ${code}: ${(err || out).trim().split('\n')[0]}`);
      resolve({ code, out, err });
    });
  });
}

const setProxy = (url) => sbx(['settings', 'set', 'proxy.sandbox', url]);
const proxyUrl = (b) => `http://${b.user}:${b.pass}@localhost:${PORT}`;

// ── de test ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`probe op http://localhost:${PORT}\n`);

  const before = await sbx(['settings', 'get', 'proxy.sandbox'], { quiet: true });
  const original = before.code === 0 ? before.out.trim() : null;
  console.log(original ? `huidige proxy.sandbox: ${original}` : 'huidige proxy.sandbox: (niet gelezen)');

  try {
    // Fase 1 — twee dozen, elk met een eigen credential in de globale instelling.
    // De instelling is globaal; de vraag is of de waarde per doos vast komt te
    // liggen op het moment van create.
    for (const box of BOXES) {
      phase = `create ${box.name}`;
      console.log(`\n[1] ${box.name}: proxy zetten en aanmaken`);
      await sbx(['rm', '--force', box.name], { quiet: true });
      const s = await setProxy(proxyUrl(box));
      if (s.code !== 0) throw new Error(`kon proxy.sandbox niet zetten — draait sbx?`);
      const c = await sbx(['create', '--name', box.name, 'claude', '.']);
      if (c.code !== 0) throw new Error(`create ${box.name} mislukt`);
    }

    // Fase 2/3 — één voor één curlen, zodat elke hit bij de juiste doos hoort.
    for (const box of BOXES) {
      phase = `curl ${box.name}`;
      console.log(`\n[2] ${box.name}: curl ${TARGET}`);
      await sbx(['exec', box.name, '--', 'curl', '-s', '-o', '/dev/null', TARGET]);
    }

    // Fase 4 — de beslissende. De globale instelling staat nu op de LAATSTE doos.
    // Leest een herstartende doos hem opnieuw, dan presenteert doos A straks de
    // identiteit van doos B, en is dat stille overname van rechten.
    if (!flag('--no-restart')) {
      const a = BOXES[0];
      console.log(`\n[3] ${a.name} herstarten (globale proxy staat nu op ${BOXES[1].name})`);
      let r = await sbx(['restart', a.name], { quiet: true });
      if (r.code !== 0) {
        await sbx(['stop', a.name], { quiet: true });
        r = await sbx(['start', a.name], { quiet: true });
      }
      if (r.code !== 0) {
        console.log('   ! herstarten lukte niet — fase 4 overgeslagen');
      } else {
        phase = `curl ${a.name} na herstart`;
        await sbx(['exec', a.name, '--', 'curl', '-s', '-o', '/dev/null', TARGET]);
      }
    }
  } catch (err) {
    console.log(`\nAFGEBROKEN: ${err.message}`);
  } finally {
    if (original) await setProxy(original);
    if (!flag('--keep')) for (const b of BOXES) await sbx(['rm', '--force', b.name], { quiet: true });
    console.log(original ? '\nproxy.sandbox teruggezet' : '\nproxy.sandbox NIET teruggezet — controleer hem zelf');
  }

  verdict();
}

// ── wat we ervan leren ───────────────────────────────────────────────────────

function verdict() {
  console.log('\n─── waargenomen ────────────────────────────────────────────');
  if (!hits.length) {
    console.log('geen enkel verzoek ontvangen — sbx stuurt niet via deze proxy.');
    // Eerst uitsluiten voor je dit als antwoord leest: een target dat onder
    // no_proxy valt gaat langs élke -x heen, en dan meet je niets in plaats van
    // "geen identiteit".
    console.log(`controleer no_proxy/NO_PROXY tegen ${TARGET} voor je concludeert.`);
  }
  for (const h of hits) {
    console.log(`  ${h.phase.padEnd(32)} ${h.kind.padEnd(8)} ${String(h.credential ?? '(geen)').padEnd(28)} van ${h.from}`);
  }

  const credOf = (p) => hits.filter((h) => h.phase === p && h.credential).at(-1)?.credential ?? null;
  const [a, b] = BOXES;
  const ca = credOf(`curl ${a.name}`), cb = credOf(`curl ${b.name}`);
  const ra = credOf(`curl ${a.name} na herstart`);

  console.log('\n─── conclusie ──────────────────────────────────────────────');
  if (!ca && !cb) {
    console.log('  GEEN identiteit. De credential uit de proxy-URL bereikt ons niet;');
    console.log('  dan is er via dit kanaal niets te identificeren.');
    return;
  }
  const want = (x) => `${x.user}:${x.pass}`;
  const okA = ca === want(a), okB = cb === want(b);
  console.log(`  ${a.name}: ${ca ?? '(geen)'}  ${okA ? 'OK' : '← verwacht ' + want(a)}`);
  console.log(`  ${b.name}: ${cb ?? '(geen)'}  ${okB ? 'OK' : '← verwacht ' + want(b)}`);
  if (okA && okB) {
    console.log('  → De URL wordt per doos ingebakken bij create. Identiteit werkt.');
  } else if (ca && ca === cb) {
    console.log('  → Beide dozen presenteren dezelfde credential: de daemon leest de');
    console.log('    globale instelling live. Dan is dit kanaal geen identiteit.');
  }

  if (ra !== null) {
    console.log(`\n  na herstart van ${a.name}: ${ra}`);
    if (ra === want(a)) console.log('  → Herstart behoudt de identiteit. Geen mitigatie nodig.');
    else console.log(`  → Herstart neemt de globale waarde over (${ra}). De unclaimed-mitigatie`);
    if (ra !== want(a)) console.log('    uit de ADR is verplicht: dit is stille overname van rechten.');
  }
}

server.listen(PORT, () => { void main().then(() => server.close()); });
