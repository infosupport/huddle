// PoC: Settings → Folder mappings ook in een sbx-sandbox, via symlinks.
//
// Het idee:
//   1. Op de host: per mapping een link ~/.huddle/sbx/links/<doos>/<id> → hostPath
//      (op Windows een junction, die heeft geen admin of developer mode nodig).
//   2. De map ~/.huddle/sbx/links/<doos> gaat als extra workspace mee met `sbx create`.
//   3. In de doos: `ln -sfn <mountpad>/<id> <containerPath>`.
//
// Ronde 1 (Windows, sbx v0.39.0): de links-map als workspace werkt, de link zelf
// als workspace niet (de doos ziet de map dan niet). Deze ronde test daarom alleen
// de links-map, en wat nodig is om hem veilig te gebruiken:
//
//   rw  links-map gewoon gemount, voor mappings die schrijfbaar zijn. Plus: kan de
//       doos in die map zelf een link maken die de host volgt? Dan kan hij naar
//       elke map op de host uitbreken, want de share volgt links aan de hostkant
//       (zo werkt stap 2 juist).
//   ro  links-map met :ro, voor read-only mappings. Geldt :ro ook door de
//       junction heen, en kan de doos er dan niets meer in aanmaken?
//       Ronde 2: :ro geldt NIET door de junction heen. Daarom ook:
//   dro de map van de mapping zelf direct met :ro (geen links-map). Geldt :ro
//       daar wel, en ook door een junction die de gebruiker zelf IN die map heeft?
//
//   node sbx-folder-links-poc.mjs [--agent claude] [--container-path <pad>] [--keep]
//
// --container-path  waar de mapping in de doos moet verschijnen
//                   (standaard $HOME/huddle-poc-mapping van de doosgebruiker)
// --keep            ruimt de testdozen en testmappen niet op
//
// SBX_BIN wijst naar een andere sbx. Alles stdlib. Het script raakt alleen zijn
// eigen dozen (huddle-links-poc-rw/-ro/-dro), een tijdelijke map en
// ~/.huddle/sbx/links/huddle-links-poc-*; de rest van ~/.huddle blijft ongemoeid.
// Links in die mappen worden bij het opruimen ontkoppeld, nooit gevolgd.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const SBX = process.env.SBX_BIN ?? 'sbx';
const AGENT = val('--agent', 'claude');
const CONTAINER_PATH = val('--container-path', '$HOME/huddle-poc-mapping');
const LINKS_ROOT = path.join(os.homedir(), '.huddle', 'sbx', 'links');
const WIN = process.platform === 'win32';

// ── helpers ──────────────────────────────────────────────────────────────────

// Geen shell: cmd.exe zou argv opnieuw parsen.
function sbx(argv, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(SBX, argv, { shell: false, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    p.on('close', (code) => {
      if (!quiet && code !== 0) console.log(`   ! sbx ${argv.join(' ')} → ${code}: ${(err || out).trim().split('\n')[0]}`);
      resolve({ code, out, err });
    });
  });
}

// Eén shell-regel in de doos. $HOME en dergelijke worden dáár uitgevuld.
const inBox = (name, script) => sbx(['exec', name, '--', 'sh', '-c', script], { quiet: true });
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const firstLine = (r) => (r.err || r.out).trim().split('\n')[0];

const results = [];
function check(variant, step, ok, detail = '') {
  results.push({ variant, step, ok, detail });
  console.log(`   ${ok === true ? '✓' : ok === false ? '✗' : '·'} ${step}${detail ? `: ${detail}` : ''}`);
}

// Ruimt een map op zonder ooit een link te volgen: een link (symlink of junction)
// wordt alleen zelf verwijderd. De doos kan in de rw-map links hebben gezet.
function removeNoFollow(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
  } else if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) removeNoFollow(path.join(p, e));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

// ── opzet op de host ─────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-links-poc-'));
const work = path.join(tmp, 'work');          // primaire workspace (sbx wil er één)
const src = path.join(tmp, 'mapping-src');    // staat model voor hostPath van een mapping
const secret = path.join(tmp, 'not-mapped');  // mag de doos nooit zien
fs.mkdirSync(work);
fs.mkdirSync(src);
fs.mkdirSync(secret);

const token = crypto.randomBytes(6).toString('hex');
const marker = `marker-${token}.txt`;
const secretMarker = `secret-${token}.txt`;
fs.writeFileSync(path.join(src, marker), token);
fs.writeFileSync(path.join(secret, secretMarker), 'secret');

function makeLinksDir(box) {
  const dir = path.join(LINKS_ROOT, box);
  removeNoFollow(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(src, path.join(dir, 'm1'), WIN ? 'junction' : 'dir');
  return dir;
}

// ── één variant ──────────────────────────────────────────────────────────────

async function variant(label, box, readOnly) {
  const hostDir = makeLinksDir(box);
  console.log(`\n── ${label} (${box}) ──`);
  console.log(`   workspace: ${hostDir}${readOnly ? ':ro' : ''}`);
  await sbx(['rm', '--force', box], { quiet: true });

  const c = await sbx(['create', '--name', box, AGENT, work, readOnly ? `${hostDir}:ro` : hostDir]);
  if (c.code !== 0) { check(label, 'sbx create', false, firstLine(c)); return; }
  check(label, 'sbx create', true);

  // Waar staat de marker in de doos? -L volgt links. /proc en /sys overslaan.
  const f = await inBox(box, `find -L / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -name ${q(marker)} -print 2>/dev/null | head -5`);
  const hits = f.out.trim().split('\n').filter(Boolean);
  check(label, 'marker gevonden in de doos', hits.length > 0, hits.join(', ') || firstLine(f));
  if (hits.length === 0) return;

  const hit = hits.find((h) => h.endsWith(`/${box}/m1/${marker}`)) ?? hits[0];
  const mapped = path.posix.dirname(hit);       // .../links/<doos>/m1
  const linksDir = path.posix.dirname(mapped);  // .../links/<doos>
  const cat = await inBox(box, `cat ${q(hit)}`);
  check(label, 'marker leesbaar', cat.out.trim() === token, cat.out.trim() || firstLine(cat));

  // Schrijven door de junction heen: rw moet lukken, ro moet geweigerd worden.
  const fromBox = `from-box-${label}-${token}.txt`; // per variant: ze delen de bronmap
  const w = await inBox(box, `echo ok > ${q(`${mapped}/${fromBox}`)}`);
  const onHost = fs.existsSync(path.join(src, fromBox));
  if (readOnly) {
    check(label, ':ro geldt ook door de junction', w.code !== 0 && !onHost, onHost ? `bestand staat op de host! (exit ${w.code})` : firstLine(w));
  } else {
    check(label, 'schrijven in de doos komt op de host', w.code === 0 && onHost, w.code !== 0 ? firstLine(w) : onHost ? '' : 'niet op de host');
  }

  // Uitbreken: de doos zet zelf links in de links-map, naar de map die NIET
  // gemapt is. Drie vormen, want onbekend is hoe de share ze aan de hostkant opslaat.
  // esc_posix is het hostpad zoals de doos het schrijft: op Windows /c/Users/...
  // (zo staan de workspaces in de doos), elders gewoon het hostpad.
  const tries = {
    esc_win: secret,
    esc_posix: WIN ? `/${secret[0].toLowerCase()}${secret.slice(2).split('\\').join('/')}` : secret,
    esc_rel: path.relative(path.join(LINKS_ROOT, box), secret).split(path.sep).join('/'),
  };

  for (const [name, target] of Object.entries(tries)) {
    const mk = await inBox(box, `ln -s ${q(target)} ${q(`${linksDir}/${name}`)} && ls ${q(`${linksDir}/${name}/`)}`);
    const seenInBox = mk.out.includes(secretMarker);
    let hostSide = 'niet op de host';
    let hostFollows = false;
    try {
      const st = fs.lstatSync(path.join(hostDir, name));
      hostSide = st.isSymbolicLink() ? `link → ${fs.readlinkSync(path.join(hostDir, name))}` : st.isDirectory() ? 'map' : 'gewoon bestand';
      hostFollows = fs.readdirSync(path.join(hostDir, name)).includes(secretMarker);
    } catch { /* bestaat niet of volgt niet */ }
    const escaped = seenInBox || hostFollows;
    const how = mk.code !== 0 ? `ln/ls faalde: ${firstLine(mk)}` : `doos ziet ${seenInBox ? 'DE GEHEIME MAP' : 'niets'}`;
    check(label, `doos maakt link ${name} naar niet-gemapte map`, !escaped, `${how}; host: ${hostSide}${hostFollows ? ' (host volgt hem!)' : ''}`);
  }

  // Na `sbx stop` + opnieuw starten: ziet de doos dan wél de geheime map? Dan
  // zou de share de links bij het opstarten aan de hostkant oplossen.
  if (!readOnly) {
    const ln = await inBox(box, `mkdir -p "$(dirname "${CONTAINER_PATH}")" && ln -sfn ${q(mapped)} "${CONTAINER_PATH}" && cat "${CONTAINER_PATH}/${marker}"`);
    check(label, `ln -sfn → ${CONTAINER_PATH}`, ln.out.trim() === token, ln.code !== 0 ? firstLine(ln) : '');
    await sbx(['stop', box]);
    const again = await inBox(box, `cat "${CONTAINER_PATH}/${marker}"; for n in ${Object.keys(tries).join(' ')}; do ls ${q(linksDir)}/$n/ 2>/dev/null; done`);
    check(label, 'link werkt nog na sbx stop + exec', again.out.includes(token), again.out.includes(token) ? '' : firstLine(again));
    check(label, 'na herstart nog steeds geen geheime map', !again.out.includes(secretMarker), again.out.includes(secretMarker) ? 'doos ziet de geheime map!' : '');
  }
}

// ── de map zelf direct met :ro ───────────────────────────────────────────────

async function directRo(label, box) {
  // Een junction die de gebruiker zelf in een gemapte map kan hebben, naar een
  // map die niet gemapt is: geldt :ro daar ook?
  const inner = path.join(src, 'j');
  removeNoFollow(inner);
  fs.symlinkSync(secret, inner, WIN ? 'junction' : 'dir');
  console.log(`\n── ${label} (${box}) ──`);
  console.log(`   workspace: ${src}:ro  (met junction j → niet-gemapte map erin)`);
  await sbx(['rm', '--force', box], { quiet: true });
  try {
    const c = await sbx(['create', '--name', box, AGENT, work, `${src}:ro`]);
    if (c.code !== 0) { check(label, 'sbx create', false, firstLine(c)); return; }
    check(label, 'sbx create', true);

    const f = await inBox(box, `find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -name ${q(marker)} -print 2>/dev/null | head -5`);
    const hit = f.out.trim().split('\n').filter(Boolean)[0];
    check(label, 'marker gevonden in de doos', !!hit, hit || firstLine(f));
    if (!hit) return;
    const dir = path.posix.dirname(hit);
    const cat = await inBox(box, `cat ${q(hit)}`);
    check(label, 'marker leesbaar', cat.out.trim() === token, cat.out.trim() || firstLine(cat));

    const top = `dro-top-${token}.txt`;
    const w1 = await inBox(box, `echo ok > ${q(`${dir}/${top}`)}`);
    const on1 = fs.existsSync(path.join(src, top));
    check(label, ':ro geldt in de map zelf', w1.code !== 0 && !on1, on1 ? 'bestand staat op de host!' : firstLine(w1));

    const via = `dro-junction-${token}.txt`;
    const w2 = await inBox(box, `ls ${q(`${dir}/j/`)}; echo ok > ${q(`${dir}/j/${via}`)}`);
    const on2 = fs.existsSync(path.join(secret, via));
    check(label, 'doos ziet via junction j de niet-gemapte map', null, w2.out.includes(secretMarker) ? 'ja (junction wordt aan de hostkant gevolgd)' : 'nee');
    check(label, ':ro geldt ook door junction j', !on2, on2 ? 'bestand staat op de host!' : firstLine(w2));
  } finally {
    removeNoFollow(inner);
  }
}

// ── draaien ──────────────────────────────────────────────────────────────────

const boxes = ['huddle-links-poc-rw', 'huddle-links-poc-ro', 'huddle-links-poc-dro'];
let exitCode = 0;
try {
  const v = await sbx(['version'], { quiet: true });
  if (v.code !== 0) throw new Error(`sbx niet gevonden of draait niet (${SBX}): ${firstLine(v)}`);
  console.log(`sbx: ${v.out.trim().split('\n')[0]}   platform: ${process.platform}`);
  console.log(`bron (hostPath): ${src}`);
  console.log(`niet gemapt:     ${secret}`);

  await variant('rw', boxes[0], false);
  await variant('ro', boxes[1], true);
  await directRo('dro', boxes[2]);
} catch (e) {
  console.error(`\nAfgebroken: ${e.message}`);
  exitCode = 1;
} finally {
  if (!flag('--keep')) {
    for (const box of boxes) {
      await sbx(['rm', '--force', box], { quiet: true });
      removeNoFollow(path.join(LINKS_ROOT, box));
    }
    removeNoFollow(tmp);
  } else {
    console.log(`\n--keep: dozen ${boxes.join(', ')}, ${tmp} en ${LINKS_ROOT}${path.sep}huddle-links-poc-* blijven staan.`);
  }
}

console.log('\n── samenvatting ──');
for (const r of results.filter((x) => x.ok !== null)) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.variant.padEnd(3)} ${r.step}${r.detail ? `  (${r.detail})` : ''}`);
}
const ok = (v) => results.some((r) => r.variant === v) && results.filter((r) => r.variant === v).every((r) => r.ok !== false);
console.log(`\nrw: ${ok('rw') ? 'WERKT en veilig' : 'NIET OK, zie ✗ hierboven'}`);
console.log(`ro: ${ok('ro') ? 'WERKT en veilig' : 'NIET OK, zie ✗ hierboven'}`);
console.log(`dro: ${ok('dro') ? 'WERKT en veilig' : 'NIET OK, zie ✗ hierboven'}`);
process.exit(exitCode);
