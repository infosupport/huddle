// Kan de gateway zien WELKE sandbox belt?
//
// De hele vraag in één run. sbx' host-daemon termineert en herschrijft alles wat
// uit een doos komt, dus bronadres en headers zijn geen identiteit. Wat overblijft
// is de credential in de upstream-proxy-URL: die presenteert de daemon áán ons,
// en volgens de docs bakt sbx hem in bij `create`. Dit script controleert of dat
// echt zo is — en wat er bij een herstart gebeurt.
//
//   node sbx-identity-test.mjs [--port 32999] [--keep] [--no-restart]
//
// --keep       ruimt de testsandboxen niet op
// --no-restart slaat de herstart-fase over
//
// SBX_BIN wijst naar een andere sbx (of naar een stub, om het script zelf te
// beproeven zonder sandboxen aan te maken).
//
// Elke doos belt een EIGEN bestemming. Een sandbox praat namelijk uit zichzelf
// ook — agent-updates, telemetrie — en die verzoeken komen door dezelfde proxy
// binnen. Toewijzen op "welke fase liep er toen" telt dat achtergrondverkeer mee
// en levert een antwoord op dat er stellig uitziet en niets betekent. CONNECT
// toont de doelhost, dus laat die de hit tekenen: example.com hoort bij doos A,
// example.org bij doos B, example.net bij doos A na herstart. Alles wat daar
// niet bij staat is ruis, en zichtbaar als ruis.
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
  { name: 'huddle-probe-a', user: 'huddle-probe-a', pass: 'secret-a', target: 'example.com' },
  { name: 'huddle-probe-b', user: 'huddle-probe-b', pass: 'secret-b', target: 'example.org' },
];
// Aparte bestemming voor de herstart, zodat die hit niet op één hoop valt met de
// eerste curl van doos A.
const RESTART_TARGET = 'example.net';

// Zelfde ontsnapping als ops.ts (HUDDLE_SBX_BIN), zodat dit script tegen een stub
// gedraaid kan worden.
const SBX = process.env.SBX_BIN ?? 'sbx';

// ── de luisteraar ────────────────────────────────────────────────────────────
//
// Handhaaft niets. Noteert alleen welke credential er binnenkwam en waarheen.

const t0 = Date.now();
let phase = 'setup';
const hits = [];
// Policy-regels die we globaal moesten zetten omdat sandbox-scope niet lukte:
// die overleven `sbx rm` en moeten we zelf opruimen.
const globalRules = [];

function credentialOf(headers) {
  const raw = headers['proxy-authorization'];
  if (!raw) return null;
  const [scheme, value] = String(raw).split(/\s+/, 2);
  if (!/^basic$/i.test(scheme) || !value) return String(raw);
  try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return String(raw); }
}

function note(kind, target, socket, headers) {
  hits.push({
    at: ((Date.now() - t0) / 1000).toFixed(1),
    phase, kind,
    host: String(target).replace(/^https?:\/\//, '').split(/[:/]/)[0],
    target,
    from: socket.remoteAddress,
    credential: credentialOf(headers),
  });
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

/**
 * sbx handhaaft zijn eigen policy VOOR hij naar de upstream-proxy gaat: een
 * doelwit dat niet in de allowlist van de doos staat wordt met 403 geweigerd en
 * bereikt ons nooit. Zonder deze regel meet je die weigering in plaats van de
 * identiteit. Sandbox-scope eerst, want dan verdwijnt de regel met de doos.
 */
async function allowTarget(box, host) {
  const scoped = await sbx(['policy', 'allow', 'network', host, '--sandbox', box.name], { quiet: true });
  if (scoped.code === 0) return 'sandbox';
  const global = await sbx(['policy', 'allow', 'network', host], { quiet: true });
  if (global.code === 0) return 'global';
  console.log(`   ! kon ${host} niet toestaan voor ${box.name} — verwacht een 403`);
  return null;
}

/**
 * Eén curl in een doos, met de uitkomst zichtbaar. Zwijgend een exitcode 0
 * accepteren is hier gevaarlijk: dan lijkt "geen hit" een uitspraak over sbx,
 * terwijl curl misschien niet eens bestaat in het image.
 */
async function curlFrom(box, host) {
  const scope = await allowTarget(box, host);
  if (scope === 'global') globalRules.push(host);
  const url = `https://${host}`;
  const r = await sbx(['exec', box.name, '--', 'curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', url]);
  const said = (r.out || r.err).trim().split('\n').pop() || '(niets)';
  console.log(`     ${box.name} → ${url}: exit ${r.code}, curl zei ${said}`);
}

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

    // Fase 2 — elk naar zijn eigen host, zodat de hit zichzelf toewijst.
    for (const box of BOXES) {
      phase = `curl ${box.name}`;
      console.log(`\n[2] ${box.name}: curl https://${box.target}`);
      await curlFrom(box, box.target);
    }

    // Fase 3 — de beslissende. De globale instelling staat nu op de LAATSTE doos.
    // Leest een herstartende doos hem opnieuw, dan presenteert doos A straks de
    // identiteit van doos B, en is dat stille overname van rechten.
    if (!flag('--no-restart')) {
      const a = BOXES[0];
      console.log(`\n[3] ${a.name} herstarten (globale proxy staat nu op ${BOXES[1].name})`);
      if (await restart(a.name)) {
        phase = `curl ${a.name} na herstart`;
        console.log(`     gestopt — de curl hierna start hem weer`);
        await curlFrom(a, RESTART_TARGET);
      } else {
        // Welke werkwoorden sbx wél heeft, is de helft van het antwoord: heeft
        // het er geen, dan kan Huddle een herstart ook niet zelf afdwingen en is
        // de mitigatie uit de ADR het enige dat overblijft.
        console.log('   ! stoppen lukte niet — fase 3 overgeslagen');
        const help = await sbx(['--help'], { quiet: true });
        console.log((help.out || help.err).trim().split('\n').map((l) => `     ${l}`).join('\n'));
      }
    }
  } catch (err) {
    console.log(`\nAFGEBROKEN: ${err.message}`);
  } finally {
    await restore(original);
    for (const host of globalRules) await sbx(['policy', 'rm', 'network', host], { quiet: true });
    if (!flag('--keep')) for (const b of BOXES) await sbx(['rm', '--force', b.name], { quiet: true });
  }

  verdict();
}

/**
 * sbx heeft `stop` en geen `start` of `restart` (bevestigd via `sbx --help`,
 * 2026-08-30). Een gestopte doos komt terug zodra je hem gebruikt, dus de curl
 * hierna IS de herstart. Dat maakt het gevaar uit de ADR groter, niet kleiner:
 * er is geen moment waarop iemand bewust "herstart" zegt.
 */
async function restart(name) {
  return (await sbx(['stop', name], { quiet: true })).code === 0;
}

/**
 * Terugzetten is niet optioneel. Blijft proxy.sandbox op onze poort staan, dan
 * praat elke sandbox die de operator hierna maakt tegen niets — de test zou zijn
 * machine kapot achterlaten.
 */
async function restore(original) {
  // Een eerdere run die halverwege afbrak laat ONZE url achter. Die weer
  // "terugzetten" bewaart precies de kapotte toestand die we wilden vermijden.
  if (original && original.includes(`:${PORT}`)) {
    console.log(`\n!! wat er stond was onze eigen probe-url (${original}) — niet teruggezet.`);
    original = null;
  }
  if (original) {
    const r = await setProxy(original);
    console.log(r.code === 0 ? `\nproxy.sandbox teruggezet op ${original}` : `\n!! proxy.sandbox NIET teruggezet — zet zelf: sbx settings set proxy.sandbox ${original}`);
    return;
  }
  // Niets om terug te zetten en toch iets achtergelaten. Leeg zetten is het beste
  // dat we kunnen; lukt dat niet, zeg het hard.
  for (const argv of [['settings', 'unset', 'proxy.sandbox'], ['settings', 'set', 'proxy.sandbox', '']]) {
    if ((await sbx(argv, { quiet: true })).code === 0) {
      console.log('\nproxy.sandbox leeggemaakt (er stond niets toen we begonnen)');
      return;
    }
  }
  console.log('\n!! proxy.sandbox staat nog op onze DODE poort. Zet hem zelf terug:');
  console.log('   sbx settings set proxy.sandbox http://localhost:32768   (wat Huddle gebruikt)');
}

// ── wat we ervan leren ───────────────────────────────────────────────────────

function verdict() {
  const mine = new Set([...BOXES.map((b) => b.target), RESTART_TARGET]);

  console.log('\n─── waargenomen ────────────────────────────────────────────');
  if (!hits.length) {
    console.log('geen enkel verzoek ontvangen — sbx stuurt niet via deze proxy.');
    console.log(`controleer no_proxy/NO_PROXY tegen ${[...mine].join(', ')} voor je concludeert.`);
    return;
  }
  for (const h of hits) {
    const tag = mine.has(h.host) ? '' : '(achtergrond)';
    // De fase erbij, want bij achtergrondverkeer is "wanneer" de hele uitspraak:
    // een doos die tijdens de create van de VOLGENDE doos nog zijn eigen
    // credential toont, heeft hem ingebakken gekregen.
    console.log(`  +${h.at.padStart(5)}s ${h.phase.padEnd(24)} ${h.host.padEnd(18)} ${String(h.credential ?? '(geen)').padEnd(28)}${tag}`);
  }

  // Toewijzing op bestemming, niet op tijd: de curl van doos A is het verzoek
  // naar example.com, wat er verder ook langskwam.
  const credFor = (host) => hits.filter((h) => h.host === host && h.credential).at(-1) ?? null;
  const [a, b] = BOXES;
  const ha = credFor(a.target), hb = credFor(b.target), hr = credFor(RESTART_TARGET);
  const want = (x) => `${x.user}:${x.pass}`;

  console.log('\n─── conclusie ──────────────────────────────────────────────');
  if (!ha && !hb) {
    console.log('  Geen van beide curls bereikte de proxy. Kijk eerst naar de exitcodes');
    console.log('  hierboven en naar no_proxy/NO_PROXY voor je hier iets uit afleidt.');
    return;
  }
  for (const [box, hit] of [[a, ha], [b, hb]]) {
    const got = hit?.credential ?? '(geen)';
    console.log(`  ${box.name} (${box.target}): ${got}  ${got === want(box) ? 'OK' : '← verwacht ' + want(box)}`);
  }
  if (ha?.credential === want(a) && hb?.credential === want(b)) {
    console.log('  → De URL wordt per doos ingebakken bij create. Identiteit werkt.');
  } else if (ha && ha.credential === hb?.credential) {
    console.log('  → Beide dozen presenteren dezelfde credential: de daemon leest de');
    console.log('    globale instelling live. Dan is dit kanaal geen identiteit.');
  } else {
    console.log('  → Gemengd beeld. Lees de regels hierboven op tijdstip: de achtergrond-');
    console.log('    hits laten zien wat een doos uit zichzelf presenteert.');
  }

  if (hr) {
    console.log(`\n  na herstart van ${a.name} (${RESTART_TARGET}): ${hr.credential}`);
    if (hr.credential === want(a)) console.log('  → Herstart behoudt de identiteit. Geen mitigatie nodig.');
    else {
      console.log(`  → Herstart neemt de globale waarde over (${hr.credential}). De unclaimed-`);
      console.log('    mitigatie uit de ADR is verplicht: dit is stille overname van rechten.');
    }
  }
}

server.listen(PORT, () => { void main().then(() => server.close()); });
