#!/usr/bin/env node
'use strict';

/**
 * Builds Huddle Node as a single executable (SEA).
 *
 * Closes the gap marked "PACKAGING GAP (deliberately not solved here)" in
 * cli/src/node.ts: `huddle node` could run an existing build but never make one,
 * and the published CLI has no dependencies while Huddle Node needs fastify.
 *
 *   tsc → esbuild → collect assets → sea-config → node --experimental-sea-config
 *       → cp node → postject inject → smoke test → rename
 *
 * The rename is last on purpose. A copy of `node` that was NOT injected is a
 * working REPL, so a half-built artefact named `huddle-node` would start, answer
 * nothing, and surface as "started but is not answering" 30 seconds later in
 * `huddle init` — the one failure the CLI cannot diagnose. The final name is
 * therefore earned by injection *and* a passing smoke test, never by reaching the
 * end of the script.
 *
 * Usage: node scripts/build-sea.mjs [--skip-tsc] [--skip-ui] [--out DIR]
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(HERE, '..');
const ROOT = path.resolve(GATEWAY, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flagValue = (f, dflt) => {
  const i = argv.indexOf(f);
  return i === -1 ? dflt : argv[i + 1];
};

const OUT = path.resolve(flagValue('--out', path.join(GATEWAY, 'build', 'sea')));
const BUNDLE = path.join(OUT, 'huddle-node.cjs');
const BLOB = path.join(OUT, 'huddle-node.blob');
/**
 * Windows runs a file because of its extension, not its content: an
 * extensionless copy of node.exe is inert there, however correctly injected.
 * The staged name keeps it too, because step 8 EXECUTES the staged copy.
 */
const EXE = process.platform === 'win32' ? '.exe' : '';
const STAGED = path.join(OUT, `huddle-node.staged${EXE}`);
const FINAL = path.join(OUT, `huddle-node${EXE}`);
const UI_DIR = path.join(GATEWAY, 'dist', 'ui', 'browser');

/** Node ships the reader, not the injector; postject does the writing. */
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/**
 * Blocks the thread. Not `execFileSync('sleep')`: there is no sleep on Windows,
 * and the one caller is a retry loop that must not turn into a hard failure on
 * the platform it cannot run on.
 */
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: GATEWAY, ...opts });
}

/**
 * Resolves a build tool to the JS file its package declares as `bin`, to be run
 * as `node <entry>` — never to the shim in node_modules/.bin.
 *
 * The shim is the wrong thing to execute, for two independent reasons:
 *
 * 1. On Windows the extensionless entry in .bin is a POSIX sh script, which
 *    CreateProcess cannot run at all: `spawnSync … ENOENT`, and existsSync()
 *    happily reports it as present. Its `.cmd` sibling needs a shell, which
 *    execFileSync deliberately does not provide. Both failure modes point at a
 *    file that is right there on disk, so they read as a broken install.
 * 2. A shim runs whichever node is first on PATH. The blob in step 6 and the
 *    injection in step 7 must come from THIS node — a SEA blob carries a code
 *    cache bound to the V8 that wrote it.
 *
 * GATEWAY first, always. esbuild and postject are devDependencies of
 * gateway/package.json — deliberately not of the monorepo root, whose
 * package.json carries an `install` LIFECYCLE script that re-invokes npm in
 * every subdirectory. Anything that makes `npm install` in the root part of a
 * normal workflow re-enters that script, so nothing here should need it.
 * The other two are searched only as a fallback for a pre-existing checkout.
 */
function resolveCli(pkg, binName = pkg) {
  for (const base of [GATEWAY, ROOT, path.join(GATEWAY, 'frontend')]) {
    const dir = path.join(base, 'node_modules', pkg);
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const rel = typeof bin === 'string' ? bin : bin?.[binName];
    if (!rel) throw new Error(`${pkg} declares no "${binName}" bin`);
    return path.join(dir, rel);
  }
  throw new Error(
    `${pkg} not found — run \`npm install\` in gateway/ (NOT in the repo root)`,
  );
}

/**
 * Runs a package's declared bin, without assuming what kind of file it is.
 *
 * A `bin` entry is not necessarily a script: esbuild's installer overwrites its
 * own bin/esbuild with the platform executable to save a process on every call,
 * so the same path is an ELF/Mach-O binary on some machines and a
 * `#!/usr/bin/env node` shim on others (Windows, where an extensionless
 * executable cannot be run, keeps the shim). Two bytes settle it, and nothing
 * here has to track which package does what on which platform.
 *
 * Scripts run under process.execPath rather than their shebang: postject in
 * particular must run under the SAME node that produced the blob, because a SEA
 * blob carries a code cache bound to the V8 that wrote it.
 */
function runCli(pkg, binName, args, opts) {
  const entry = resolveCli(pkg, binName);
  const head = Buffer.alloc(2);
  const fd = fs.openSync(entry, 'r');
  try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
  const isScript = head.toString('latin1') === '#!';
  return run(...(isScript ? [process.execPath, [entry, ...args]] : [entry, args]), opts);
}

// ---------------------------------------------------------------- 1. compile

fs.mkdirSync(OUT, { recursive: true });

if (!has('--skip-ui')) {
  step(1, 'Building the portal');
  run('npm', ['run', 'build:ui']);
} else {
  step(1, 'Skipping portal build (--skip-ui)');
}

if (!has('--skip-tsc')) {
  step(2, 'Type-checking');
  runCli('typescript', 'tsc', []);
  ok('tsc clean');
} else {
  step(2, 'Skipping tsc (--skip-tsc)');
}

// ----------------------------------------------------------------- 3. bundle

step(3, 'Bundling');

/**
 * Three things this banner has to get right, all of them measured rather than
 * reasoned about:
 *
 * 1. It must itself start with "use strict". The bundle's own first line is
 *    `"use strict";`; prepending anything demotes that from directive prologue
 *    to an ordinary expression and silently drops the WHOLE bundle out of strict
 *    mode. Nothing warns about this.
 *
 * 2. `require` must be rebound. Inside a SEA, `require` is Node's
 *    `embedderRequire` — a bare function with no `.cache` and no `.resolve`.
 *    That breaks two things: every `loadExtension()` throws a TypeError on
 *    `require.cache` in unloadModule(), which loadAllExtensions swallows per
 *    directory, so *every extension fails silently*. createRequire(process.execPath)
 *    restores a real require, cache and all.
 *
 * 3. `__dirname` does not exist in a SEA. It appears 5× — 4× in pino (dead code:
 *    both fastify instances run `logger: false`) and once in api.ts's UI_DIR.
 *    --define rewrites them to a path derived from the binary's own location.
 */
const BANNER = [
  '"use strict";',
  'require = require("node:module").createRequire(process.execPath);',
  'var __HUDDLE_ROOT = require("node:path").dirname(process.execPath);',
].join(' ');

runCli('esbuild', 'esbuild', [
  'src/index.ts',
  '--bundle',
  '--platform=node',
  '--target=node24',
  '--format=cjs',
  '--define:__dirname=__HUDDLE_ROOT',
  `--banner:js=${BANNER}`,
  // process.setSourceMapsEnabled() in a banner does NOT work: maybeCacheSourceMap
  // runs at compile time, and the SEA main is compiled before its first statement
  // executes. External map + symbolise offline.
  '--sourcemap=external',
  `--source-root=${GATEWAY}`,
  '--legal-comments=external',
  '--log-limit=0',
  // Deliberately not minified. For a security product a readable bundle is worth
  // 1.6 MB in a ~130 MB binary: auditable, diffable between releases, and usable
  // stack traces without a runtime flag.
  `--outfile=${BUNDLE}`,
]);

const bundleBytes = fs.statSync(BUNDLE).size;
ok(`${path.relative(GATEWAY, BUNDLE)} — ${mb(bundleBytes)}`);

const bundleSrc = fs.readFileSync(BUNDLE, 'utf8');
if (!bundleSrc.startsWith('"use strict";')) {
  throw new Error('bundle does not open with "use strict" — the banner broke strict mode');
}
if (!bundleSrc.slice(0, 400).includes('createRequire')) {
  throw new Error('banner missing from bundle — every extension would fail to load at runtime');
}
ok('strict mode intact, require rebound');

// ----------------------------------------------------------------- 4. assets

step(4, 'Collecting assets');

if (!fs.existsSync(UI_DIR)) {
  throw new Error(`portal not built: ${UI_DIR} missing (drop --skip-ui)`);
}

/** SEA assets are file-by-file: a directory gives "illegal operation on a directory". */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

const assets = {};
let uiBytes = 0;
for (const rel of walk(UI_DIR)) {
  const full = path.join(UI_DIR, rel);
  assets[`ui/${rel.split(path.sep).join('/')}`] = full;
  uiBytes += fs.statSync(full).size;
}
ok(`portal: ${Object.keys(assets).length} files, ${mb(uiBytes)}`);

// No native assets. Huddle's database is node:sqlite, which is part of the Node
// binary this SEA is built from — so there is nothing to extract, nothing to
// dlopen, and no per-ABI cache directory in the user's home.

// ----------------------------------------------------------------- 5. config

step(5, 'Writing sea-config.json');

const seaConfig = {
  main: BUNDLE,
  output: BLOB,
  // Required. `huddle init` reads ~/.huddle/node.log, and the experimental banner
  // would land in it. The cost: this shares a gate with the "require() only
  // supports built-in modules" warning, so it hides a bundling regression too —
  // which is exactly why the smoke test below is not optional.
  disableExperimentalSEAWarning: true,
  // Must stay false. With true, Node runs main at BUILD time under mksnapshot,
  // where sea.isSea() is false and getAsset() throws. Huddle Node opens SQLite, a
  // Docker socket and two listeners at module scope: not snapshottable.
  useSnapshot: false,
  // V8- and arch-bound, so the release matrix has to build natively per platform.
  useCodeCache: true,
  assets,
};

// Unknown keys are silently accepted — a typo yields a blob that still warns.
// There is no schema validation, so guard the spelling here.
const ALLOWED = new Set(['main', 'output', 'disableExperimentalSEAWarning', 'useSnapshot', 'useCodeCache', 'assets', 'execArgv']);
for (const k of Object.keys(seaConfig)) {
  if (!ALLOWED.has(k)) throw new Error(`unknown sea-config key: ${k}`);
}

const configPath = path.join(OUT, 'sea-config.json');
fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));
ok(path.relative(GATEWAY, configPath));

// ------------------------------------------------------------------- 6. blob

step(6, 'Generating the blob');
// Paths inside sea-config.json resolve against cwd, not against the config file.
// They are absolute above, so this is safe either way.
run(process.execPath, ['--experimental-sea-config', configPath], { cwd: OUT });
ok(`${path.relative(GATEWAY, BLOB)} — ${mb(fs.statSync(BLOB).size)}`);

// ----------------------------------------------------------------- 7. inject

step(7, 'Injecting');

fs.rmSync(STAGED, { force: true });
fs.rmSync(FINAL, { force: true });
fs.copyFileSync(process.execPath, STAGED);
fs.chmodSync(STAGED, 0o755);

runCli('postject', 'postject', [
  STAGED, 'NODE_SEA_BLOB', BLOB,
  '--sentinel-fuse', SENTINEL,
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
], { stdio: ['ignore', 'ignore', 'inherit'] });

ok(`injected — ${mb(fs.statSync(STAGED).size)}`);

// -------------------------------------------------------------- 8. smoke test

step(8, 'Smoke test');

/**
 * A non-injected copy of node is a working REPL, so "it starts" proves nothing —
 * and a SEA hands argv to the embedded app, so there is no `-e` to probe with.
 * The test is therefore the real boot path, in a throwaway HOME so a real
 * ~/.huddle is never touched, stopped as soon as it has proven what we need.
 *
 * Reaching bootNode() past the database means the blob was found, the embedded
 * bundle executed, and node:sqlite opened the file — the whole chain, end to end.
 */
const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-sea-smoke-'));
// `huddle init` normally creates this; the binary opens the database at module
// scope and will not create the directory itself.
fs.mkdirSync(path.join(smokeHome, '.huddle'), { recursive: true, mode: 0o700 });

/**
 * Run the copy from OUTSIDE the repository, and this is not a detail.
 * Tested in place, `createRequire(process.execPath)` walks up from build/sea and
 * finds gateway/node_modules — so a binary that is not self-contained at all
 * still passes, and only fails once a user runs it somewhere else. Anywhere
 * inside the tree is exactly the one location where that bug is invisible.
 */
const smokeBin = path.join(smokeHome, `huddle-node${EXE}`);
fs.copyFileSync(STAGED, smokeBin);
fs.chmodSync(smokeBin, 0o755);

const smoke = await new Promise((resolve) => {
  const child = spawn(smokeBin, [], {
    cwd: smokeHome,
    env: { ...process.env, HOME: smokeHome, HUDDLE_ROLE: 'node' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  const done = (verdict) => {
    clearTimeout(timer);
    child.kill('SIGKILL');
    resolve({ ...verdict, out });
  };
  const onData = (buf) => {
    out += buf.toString();
    if (/\[fatal\]/.test(out)) done({ pass: false, why: 'process reported [fatal]' });
    // Anything logged after the role line means boot got past module scope,
    // which is where the database and therefore the native addon are opened.
    else if (/\[boot\] role=node[\s\S]*\n.+/.test(out)) done({ pass: true });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => done({ pass: false, why: e.message }));

  const timer = setTimeout(() => done({ pass: false, why: 'no output within 30s' }), 30_000);
});

fs.rmSync(smokeHome, { recursive: true, force: true });

if (!smoke.pass) {
  console.error('\n✗ smoke test failed — NOT naming the artefact huddle-node.');
  console.error(`  ${smoke.why}`);
  console.error(`  Staged binary kept at ${STAGED} for inspection.`);
  console.error(smoke.out.split('\n').map((l) => `  | ${l}`).join('\n'));
  process.exit(1);
}
ok('booted as role=node past the database');

// ----------------------------------------------------------------- 9. rename

step(9, 'Naming the artefact');
fs.renameSync(STAGED, FINAL);

// Renaming ~130 MB can leave the new name briefly invisible to stat() on
// overlay and 9p filesystems (WSL2 among them). The rename itself has already
// returned, so wait for the entry rather than failing a build that succeeded.
let finalSize = 0;
for (let attempt = 0; attempt < 50; attempt++) {
  try { finalSize = fs.statSync(FINAL).size; break; } catch { sleepSync(100); }
}
if (!finalSize) throw new Error(`renamed to ${FINAL} but it never became visible`);
try { fs.chmodSync(FINAL, 0o755); } catch { /* already 0755 from STAGED */ }

console.log(`\n✓ ${path.relative(ROOT, FINAL)} — ${mb(finalSize)}\n`);
