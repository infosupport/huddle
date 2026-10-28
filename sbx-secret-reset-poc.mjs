// PoC: identiteit per sandbox via een secret in de proxy-URL, met een reset-secret
// als struikeldraad.
//
// Het ontwerp:
//   1. Bij create zet Huddle `proxy.sandbox` op een URL met een eigen secret voor
//      die doos, maakt de doos aan, en zet de instelling daarna op een RESET-secret.
//   2. Het gateway kent elk secret: secret → doos. Het reset-secret hoort bij
//      niemand en wordt geweigerd.
//   3. Komt het reset-secret ooit binnen, dan heeft sbx de netwerkproxy van een doos
//      opnieuw opgebouwd uit de globale instelling (volgens de docs gebeurt dat bij
//      `sbx daemon restart`). Dan weet Huddle niet meer welke doos welk secret
//      heeft, dus maakt het ALLE dozen opnieuw aan, elk met een nieuw secret.
//      De oude secrets worden ingetrokken.
//
// Dit script controleert elke stap tegen een echte sbx:
//
//   node sbx-secret-reset-poc.mjs [--port 32999] [--daemon] [--keep]
//
// --daemon  herstart sandboxd: de stap die het reset-secret moet laten afgaan.
//           Raakt ALLE sandboxen op deze machine, ook die van jezelf. Zonder deze
//           vlag test het script alleen create, de identiteit en een gewone stop.
// --keep    ruimt de testsandboxen niet op.
//
// SBX_BIN wijst naar een andere sbx (bijvoorbeeld een stub).
//
// Elke stap van elke doos curlt een EIGEN host. Een doos praat ook uit zichzelf
// (agent-updates, telemetrie), en alleen een eigen host per stap maakt een hit
// ondubbelzinnig. Al het andere is achtergrondverkeer en staat ook zo in de tabel.
//
// Alles stdlib. `proxy.sandbox` wordt vooraf gelezen en na afloop teruggezet, ook
// als er iets misgaat. Is sandboxd tijdens de test herstart, dan wordt hij na het
// terugzetten nog eens herstart, anders blijven je eigen sandboxen naar deze (dan
// dode) poort wijzen.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const PORT = Number(val('--port', 32999));
const SBX = process.env.SBX_BIN ?? 'sbx';
const BOX_NAMES = ['huddle-poc-a', 'huddle-poc-b'];

// Echte hosts, want CONNECT wordt doorgetunneld. Eén per (doos, stap).
const HOSTS = [
  'example.com', 'example.org', 'example.net', 'example.edu', 'www.example.com',
  'www.example.org', 'www.example.net', 'www.example.edu', 'iana.org', 'www.iana.org',
];
let nextHost = 0;
const freshHost = () => HOSTS[nextHost++ % HOSTS.length];

const newSecret = () => crypto.randomBytes(32).toString('base64url');
const RESET = { user: 'huddle-reset', pass: newSecret() };
const urlFor = (user, pass) => `http://${user}:${pass}@127.0.0.1:${PORT}`;
const mask = (s) => String(s).replace(/:\/\/([^:@/]+):[^@]+@/g, '://$1:***@');

// ── het "gateway": secret → doos, en de struikeldraad ─────────────────────────

/** secret → { box, generation }. Ingetrokken secrets blijven bewaard om hits te kunnen benoemen. */
const issued = new Map();
const revoked = new Set();
let resetTripped = null;

function identify(cred) {
  if (!cred) return { verdict: 'geen credential', allow: false };
  const [user, ...rest] = cred.split(':');
  const pass = rest.join(':');
  if (user === RESET.user && pass === RESET.pass) return { verdict: 'RESET', allow: false };
  const who = issued.get(pass);
  if (!who) return { verdict: 'onbekend', allow: false };
  if (revoked.has(pass)) return { verdict: `INGETROKKEN (${who.box} gen ${who.generation})`, allow: false };
  // De naam is alleen een hint: het secret beslist. Een secret met de verkeerde
  // naam erbij is wel een geldige doos, maar wijst op een fout.
  const note = user === who.box ? '' : ` (gebruikersnaam ${user}!)`;
  return { verdict: `${who.box} gen ${who.generation}${note}`, box: who.box, allow: true };
}

const t0 = Date.now();
let phase = 'setup';
const hits = [];

function credentialOf(headers) {
  const raw = headers['proxy-authorization'];
  if (!raw) return null;
  const [scheme, value] = String(raw).split(/\s+/, 2);
  if (!/^basic$/i.test(scheme) || !value) return null;
  try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return null; }
}

function record(kind, target, headers) {
  const id = identify(credentialOf(headers));
  const host = String(target).replace(/^https?:\/\//, '').split(/[:/]/)[0];
  hits.push({ at: ((Date.now() - t0) / 1000).toFixed(1), phase, kind, host, ...id });
  if (id.verdict === 'RESET' && !resetTripped) {
    resetTripped = { phase, host };
    console.log(`     ⚡ reset-secret geraakt (${host}, tijdens "${phase}")`);
  }
  return id;
}

// Weigert wat het echte gateway ook zou weigeren (reset, ingetrokken, onbekend),
// zodat je ziet dat het faalt naar dicht. Wat wel klopt, tunnelt door.
const server = http.createServer((req, res) => {
  const id = record('HTTP', req.url, req.headers);
  res.writeHead(id.allow ? 200 : 407, { 'content-type': 'text/plain' });
  res.end(id.allow ? 'poc ok\n' : `geweigerd: ${id.verdict}\n`);
});

server.on('connect', (req, clientSocket, head) => {
  const id = record('CONNECT', req.url, req.headers);
  clientSocket.on('error', () => clientSocket.destroy());
  if (!id.allow) {
    clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="huddle"\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const [host, port] = req.url.split(':');
  const upstream = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => { upstream.destroy(); clientSocket.destroy(); });
});

// ── sbx ──────────────────────────────────────────────────────────────────────

// Geen shell: de URL's bevatten secrets, en cmd.exe zou argv opnieuw parsen.
function sbx(argv, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(SBX, argv, { shell: false, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    p.on('close', (code) => {
      if (!quiet && code !== 0) {
        console.log(`   ! sbx ${mask(argv.join(' '))} → ${code}: ${mask((err || out).trim().split('\n')[0])}`);
      }
      resolve({ code, out, err });
    });
  });
}

const setProxy = (url) => sbx(['settings', 'set', 'proxy.sandbox', url]);

/** De dozen van deze run: naam → huidig secret en generatie. */
const boxes = new Map();
let daemonRestarted = false;

/**
 * Stap 1 van het ontwerp, in volgorde: eigen secret zetten, aanmaken, terug op
 * reset. Altijd één tegelijk: de instelling is globaal, dus twee creates door
 * elkaar heen kunnen elkaars secret krijgen. In Huddle wordt dit een lock.
 */
async function createWithSecret(name) {
  const generation = (boxes.get(name)?.generation ?? 0) + 1;
  const secret = newSecret();
  issued.set(secret, { box: name, generation });

  await sbx(['rm', '--force', name], { quiet: true });
  if ((await setProxy(urlFor(name, secret))).code !== 0) throw new Error('kon proxy.sandbox niet zetten. Draait sbx?');
  try {
    const c = await sbx(['create', '--name', name, 'claude', '.']);
    if (c.code !== 0) throw new Error(`create ${name} mislukt`);
  } finally {
    // Ook als create faalt: de instelling mag nooit op een uitgegeven secret blijven staan.
    if ((await setProxy(urlFor(RESET.user, RESET.pass))).code !== 0) throw new Error('kon proxy.sandbox niet op reset zetten');
  }
  boxes.set(name, { secret, generation });
  console.log(`     ${name}: aangemaakt met secret gen ${generation}, instelling terug op reset`);
}

/** Stap 3: alles opnieuw aanmaken, oude secrets intrekken. */
async function recreateAll() {
  for (const { secret } of boxes.values()) revoked.add(secret);
  for (const name of boxes.keys()) await createWithSecret(name);
}

/**
 * sbx weigert een host die niet in de policy van de doos staat zelf al met 403,
 * en dan bereikt het verzoek ons nooit. Eerst sandbox-scope, want die verdwijnt
 * met de doos.
 */
const globalRules = new Set();
async function allow(name, host) {
  if ((await sbx(['policy', 'allow', 'network', host, '--sandbox', name], { quiet: true })).code === 0) return;
  if ((await sbx(['policy', 'allow', 'network', host], { quiet: true })).code === 0) { globalRules.add(host); return; }
  console.log(`   ! kon ${host} niet toestaan voor ${name}. Verwacht een 403 van sbx zelf`);
}

/** Eén curl uit een doos naar een verse host; geeft die host terug om de hit op te zoeken. */
async function probe(name, label) {
  const host = freshHost();
  phase = `${label} ${name}`;
  await allow(name, host);
  const r = await sbx(['exec', name, '--', 'curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', `https://${host}`], { quiet: true });
  const said = (r.out || r.err).trim().split('\n').pop() || '(niets)';
  console.log(`     ${name} → https://${host}: exit ${r.code}, curl zei ${said}`);
  return { name, host, label };
}

async function restartDaemon() {
  for (const argv of [['daemon', 'restart'], ['daemon', 'stop']]) {
    if ((await sbx(argv, { quiet: true })).code !== 0) continue;
    if (argv[1] === 'stop' && (await sbx(['daemon', 'start'], { quiet: true })).code !== 0) continue;
    daemonRestarted = true;
    return true;
  }
  return false;
}

// ── de test ──────────────────────────────────────────────────────────────────

/** Elke probe met wat er verwacht werd. */
const checks = [];
const expect = (p, want) => checks.push({ ...p, want });

async function main() {
  console.log(`poc-gateway op http://127.0.0.1:${PORT}`);
  const before = await sbx(['settings', 'get', 'proxy.sandbox'], { quiet: true });
  const original = before.code === 0 ? before.out.trim() : null;
  console.log(`huidige proxy.sandbox: ${original ? mask(original) : '(niet gelezen)'}`);

  try {
    console.log('\n[1] aanmaken: eigen secret, create, terug op reset');
    phase = 'create';
    for (const name of BOX_NAMES) await createWithSecret(name);

    console.log('\n[2] elke doos presenteert zijn eigen secret');
    for (const name of BOX_NAMES) expect(await probe(name, 'curl'), `${name} gen 1`);

    console.log('\n[3] stop + gebruik: blijft het secret (en raakt het reset niet)?');
    const a = BOX_NAMES[0];
    if ((await sbx(['stop', a])).code === 0) expect(await probe(a, 'na stop'), `${a} gen 1`);

    if (flag('--daemon')) {
      console.log('\n[4] sandboxd herstarten: nu moet het reset-secret afgaan');
      if (await restartDaemon()) {
        for (const name of BOX_NAMES) expect(await probe(name, 'na daemon'), 'RESET');
      } else {
        console.log('   ! sandboxd niet herstart; stap 4 en 5 overgeslagen');
      }

      if (resetTripped) {
        console.log('\n[5] struikeldraad: alles opnieuw aanmaken met nieuwe secrets');
        phase = 'recreate';
        await recreateAll();
        for (const name of BOX_NAMES) expect(await probe(name, 'na recreate'), `${name} gen 2`);
      } else if (daemonRestarted) {
        console.log('   ! daemon herstart maar reset niet geraakt; stap 5 overgeslagen');
      }
    } else {
      console.log('\n(stap 4-5 overgeslagen: draai met --daemon om de struikeldraad te testen)');
    }
  } catch (err) {
    console.log(`\nAFGEBROKEN: ${err.message}`);
  } finally {
    await cleanup(original);
  }
  verdict();
}

async function cleanup(original) {
  // Een eigen poc-url (achtergebleven na een crash) zet ik niet terug.
  const ownPocUrl = Boolean(original && original.includes(`:${PORT}`));
  const toRestore = ownPocUrl ? null : original;
  if (ownPocUrl) {
    console.log(`\n!! de oude waarde was een eigen poc-url (${mask(original)}), die zet ik niet terug`);
  }
  if (toRestore) {
    const r = await setProxy(toRestore);
    console.log(r.code === 0 ? `\nproxy.sandbox teruggezet op ${mask(toRestore)}` : '\n!! proxy.sandbox NIET teruggezet, zet hem zelf terug');
  } else {
    let done = false;
    for (const argv of [['settings', 'unset', 'proxy.sandbox'], ['settings', 'set', 'proxy.sandbox', '']]) {
      if ((await sbx(argv, { quiet: true })).code === 0) { done = true; break; }
    }
    console.log(done ? '\nproxy.sandbox leeggemaakt (er stond niets)' : '\n!! proxy.sandbox staat nog op de poc-poort, zet hem zelf terug');
  }
  for (const host of globalRules) await sbx(['policy', 'rm', 'network', host], { quiet: true });
  if (!flag('--keep')) for (const name of BOX_NAMES) await sbx(['rm', '--force', name], { quiet: true });
  // Na een daemon-herstart wijzen ook je eigen sandboxen naar het reset-secret op
  // deze poort. Nog een herstart laat ze de teruggezette waarde oppakken.
  if (daemonRestarted) {
    const ok = await restartDaemon();
    console.log(ok ? 'sandboxd opnieuw herstart: je eigen sandboxen volgen de teruggezette proxy weer'
      : '!! sandboxd niet opnieuw herstart: draai zelf `sbx daemon restart`');
  }
}

function verdict() {
  const mine = new Set(checks.map((c) => c.host));
  console.log('\n─── alle verzoeken ─────────────────────────────────────────');
  if (!hits.length) {
    console.log('niets ontvangen: sbx stuurt niet via deze proxy. Controleer no_proxy.');
  }
  for (const h of hits) {
    const tag = mine.has(h.host) ? '' : '  (achtergrond)';
    console.log(`  +${h.at.padStart(6)}s ${h.phase.padEnd(26)} ${h.host.padEnd(17)} ${h.verdict}${tag}`);
  }

  console.log('\n─── conclusie ──────────────────────────────────────────────');
  let allOk = checks.length > 0;
  for (const c of checks) {
    const hit = hits.filter((h) => h.host === c.host).at(-1);
    const got = hit?.verdict ?? '(geen hit)';
    const ok = got === c.want;
    allOk &&= ok;
    console.log(`  ${ok ? 'OK  ' : 'FOUT'} ${c.label.padEnd(12)} ${c.name.padEnd(14)} ${got}${ok ? '' : `  ← verwacht ${c.want}`}`);
  }

  // Het ontwerp staat of valt hiermee: geen enkele hit mag als een ANDERE doos
  // binnenkomen, ook niet in het achtergrondverkeer.
  const wrong = hits.filter((h) => h.box && !h.phase.endsWith(h.box) && !['create', 'recreate', 'setup'].includes(h.phase) && mine.has(h.host));
  if (wrong.length) {
    allOk = false;
    console.log(`  FOUT ${wrong.length} verzoek(en) kwamen binnen als een andere doos dan die curlde`);
  }
  const revokedHits = hits.filter((h) => h.verdict.startsWith('INGETROKKEN'));
  if (revokedHits.length) console.log(`  let op: ${revokedHits.length} verzoek(en) met een ingetrokken secret (geweigerd)`);

  console.log(allOk ? '\n  → Het ontwerp houdt stand voor alles wat hierboven getest is.' : '\n  → Het ontwerp houdt NIET stand. Zie de FOUT-regels.');
}

server.listen(PORT, '127.0.0.1', () => { void main().finally(() => process.exit(0)); });
