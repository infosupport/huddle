#!/usr/bin/env node
/**
 * Runs a second, fully isolated Huddle Node next to a real (daily-driver)
 * install, so you can iterate on Node/portal/gateway code and click through
 * the real UI without touching the install you actually rely on.
 *
 * Deliberately Huddle Node only (API, portal, database, Docker orchestration,
 * sbx, extensions) — it never launches a gateway container, so it can't
 * `docker rm -f` a real install's gateway the way a second `huddle init`
 * would (init.ts hardcodes the container/network names it uses for exactly
 * that). A separate, isolated gateway container was investigated and
 * deliberately not pursued — this stays a single-process, single-command
 * tool by design; keep it that way rather than growing it back toward that shape.
 *
 * How the isolation works: cli/src/config.ts hardcodes CONFIG_DIR to
 * path.join(os.homedir(), '.huddle') — no env var reaches it, and that's
 * where config.json, node.pid, node.log, the operator token and the gateway
 * token all live. gateway/src/runtime-env.ts's dataDir defaults the same way.
 * So instead of chasing every individual override, this script points HOME
 * itself at an isolated directory: os.homedir() resolves inside it for free,
 * for both the CLI process this script spawns and the Huddle Node process
 * IT spawns in turn (nodeEnv() in cli/src/node.ts spreads the parent's env
 * forward). HUDDLE_API_PORT / HUDDLE_CONTROL_PORT move it off the real
 * install's ports so both can run at once.
 *
 * Windows: os.homedir() does NOT read HOME there — it reads USERPROFILE (falling
 * back to HOMEDRIVE+HOMEPATH, then a native GetUserProfileDirectory call, only if
 * that's unset too). Setting HOME alone is a silent no-op on Windows: the spawned
 * process resolves os.homedir() to the REAL profile regardless, and "isolated dev
 * instance" quietly becomes "second process pointed at your real ~/.huddle,
 * different ports" — confirmed live (2026-09-08): the banner printed
 * `data C:\Users\<you>\.huddle`, and it had already refreshed iptables/wiring for
 * a real devcontainer before anyone noticed. So on win32 this also overrides
 * USERPROFILE (and HOMEDRIVE/HOMEPATH, in case something reads those instead of
 * USERPROFILE) to the isolated dir — see childEnv() below.
 *
 * Subcommands:
 *   up     builds gateway+cli if needed, then runs `huddle node` in the
 *          foreground against the isolated HOME — Ctrl-C stops it. Also
 *          tees its output to a log file under the isolated HOME so a
 *          `logs` run from another terminal (or after backgrounding `up`)
 *          can follow along.
 *   logs   tails that log file. Only useful once `up` has run at least once
 *          (the file doesn't exist before that).
 *   reset  deletes the isolated HOME dir. Refuses if it resolves to your
 *          real ~/.huddle or to $HOME itself, and asks for confirmation
 *          unless you pass --yes.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_API_PORT = '25842';
const DEFAULT_CONTROL_PORT = '25843';
const DEFAULT_HOME = path.join(os.homedir(), '.huddle-dev');

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

// Resolution order matches the rest of Huddle's tooling: an explicit flag
// wins, then the env var, then the default.
function resolveDevHome(args) {
  const value = flagValue(args, '--home') ?? process.env.HUDDLE_DEV_HOME ?? DEFAULT_HOME;
  return path.resolve(value);
}

function resolveApiPort(args) {
  return flagValue(args, '--api-port') ?? process.env.HUDDLE_API_PORT ?? DEFAULT_API_PORT;
}

function resolveControlPort(args) {
  return flagValue(args, '--control-port') ?? process.env.HUDDLE_CONTROL_PORT ?? DEFAULT_CONTROL_PORT;
}

function logPath(devHome) {
  return path.join(devHome, 'dev-single.log');
}

/**
 * The env to spawn the isolated Huddle Node under. HOME is what actually
 * isolates everything on Linux/macOS (see the header comment); on win32,
 * os.homedir() ignores HOME entirely and reads USERPROFILE (or, absent that,
 * HOMEDRIVE+HOMEPATH) instead — so all three are pinned there too. Setting
 * HOME unconditionally as well is harmless everywhere (some cross-platform
 * tools check it regardless of os.homedir()) and is the one that matters on
 * Linux/macOS.
 */
function childEnv(devHome, apiPort, controlPort) {
  const env = {
    ...process.env,
    HOME: devHome,
    HUDDLE_API_PORT: apiPort,
    HUDDLE_CONTROL_PORT: controlPort,
    // Confirmed live (2026-09-08): without this, a dev instance that boots
    // alongside a real running install finds the real 'huddle' gateway
    // container and "helpfully" rewires every devcontainer on the engine to
    // it — including reissuing its OWN freshly-generated CA into containers
    // that belong to the real gateway, breaking their HTTPS until the real
    // Node's wiring runs again. This instance has no gateway of its own, so
    // it has no business touching any devcontainer. See boot-node.ts.
    HUDDLE_SKIP_GATEWAY_WIRING: '1',
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = devHome;
    // HOMEDRIVE/HOMEPATH is the same path split in two ("C:" + "\Users\you\..."),
    // not an independent value — path.resolve() on win32 always produces a
    // drive-letter-prefixed absolute path, so a plain slice(0, 2)/slice(2) is
    // exact here (no UNC-path support needed: an isolated dev-home under a
    // mapped drive is the only case this tool is meant to cover).
    env.HOMEDRIVE = devHome.slice(0, 2);
    env.HOMEPATH = devHome.slice(2);
  }
  return env;
}

/** Unconditionally (re)builds a subproject. No dist/-exists shortcut: `up` is
 * meant to always run what's actually in the checkout right now, not
 * whatever happened to be built last, so every invocation rebuilds. */
function ensureBuilt(name, entryFile) {
  console.log(`> building ${name}`);
  const script = name === 'gateway' ? 'build' : 'cli:build';
  // Same npm_execpath dance as install-subprojects.mjs: avoids a PATH-dependent
  // shell lookup for 'npm' when npm already told us exactly where it lives.
  const npmCli = process.env.npm_execpath;
  const { status, error } = npmCli
    ? spawnSync(process.execPath, [npmCli, 'run', script], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (error) {
    console.error(`failed to build ${name}: ${error.message}`);
    process.exit(1);
  }
  if (status !== 0) {
    console.error(`build failed for ${name} (exit ${status})`);
    process.exit(status ?? 1);
  }
  if (!fs.existsSync(entryFile)) {
    console.error(`build for ${name} reported success but ${entryFile} still doesn't exist — something's wrong.`);
    process.exit(1);
  }
}

function cmdUp(args) {
  const devHome = resolveDevHome(args);
  const apiPort = resolveApiPort(args);
  const controlPort = resolveControlPort(args);

  const realHome = path.join(os.homedir(), '.huddle');
  if (devHome === realHome) {
    console.error(`Refusing to run: --home/HUDDLE_DEV_HOME resolves to your real ${realHome}.`);
    console.error('This would run the dev instance against your daily-driver data. Pick a different --home.');
    process.exit(1);
  }

  fs.mkdirSync(devHome, { recursive: true, mode: 0o700 });

  ensureBuilt('gateway', path.join(ROOT, 'gateway', 'dist', 'index.js'));
  ensureBuilt('cli', path.join(ROOT, 'cli', 'dist', 'index.js'));

  const cliEntry = path.join(ROOT, 'cli', 'dist', 'index.js');
  const env = childEnv(devHome, apiPort, controlPort);

  console.log('');
  console.log('Huddle Node (dev instance) — isolated from your real install');
  console.log(`  home     ${devHome}`);
  console.log(`  portal   http://localhost:${apiPort}`);
  console.log(`  control  ${controlPort}`);
  console.log(`  log      ${logPath(devHome)}`);
  console.log('');
  console.log('Ctrl-C to stop.');
  console.log('');

  const logStream = fs.createWriteStream(logPath(devHome), { flags: 'a' });
  const child = spawn(process.execPath, [cliEntry, 'node'], { cwd: ROOT, env, stdio: ['inherit', 'pipe', 'pipe'] });

  // Tee to the terminal (this IS the foreground process) and to the log
  // file (so `dev-single logs` has something to follow, including if `up`
  // itself gets backgrounded).
  child.stdout.pipe(process.stdout);
  child.stdout.pipe(logStream);
  child.stderr.pipe(process.stderr);
  child.stderr.pipe(logStream);

  const forward = (sig) => () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  child.on('error', (err) => {
    console.error(`Failed to start Huddle Node: ${err.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    logStream.end();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}

function cmdLogs(args) {
  const devHome = resolveDevHome(args);
  const file = logPath(devHome);
  if (!fs.existsSync(file)) {
    console.error(`No log file at ${file} yet.`);
    console.error('Run `npm run dev:single -- up` at least once first (it tees its output there).');
    process.exit(1);
  }
  console.log(`> tailing ${file} (Ctrl-C to stop)`);
  const tail = spawn('tail', ['-n', '200', '-f', file], { stdio: 'inherit' });
  tail.on('error', (err) => {
    console.error(`Failed to run tail: ${err.message}`);
    process.exit(1);
  });
  tail.on('exit', (code) => process.exit(code ?? 0));
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function cmdReset(args) {
  const devHome = resolveDevHome(args);
  const realHome = path.join(os.homedir(), '.huddle');

  if (devHome === realHome || devHome === os.homedir()) {
    console.error(`Refusing to delete ${devHome} — it does not look like an isolated dev-single dir.`);
    process.exit(1);
  }
  if (!fs.existsSync(devHome)) {
    console.log(`Nothing to reset: ${devHome} does not exist.`);
    return;
  }

  if (!hasFlag(args, '--yes') && !hasFlag(args, '-y')) {
    const ok = await confirm(`Delete ${devHome} and everything in it? [y/N] `);
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  fs.rmSync(devHome, { recursive: true, force: true });
  console.log(`Removed ${devHome}.`);
}

function usage() {
  console.log(`Usage: npm run dev:single -- <up|logs|reset> [options]

  up      rebuild gateway+cli, then run \`huddle node\` in the foreground
          against an isolated HOME
  logs    tail the log file \`up\` writes (run from another terminal)
  reset   delete the isolated HOME dir (asks for confirmation)

Options:
  --home <path>          isolated HOME dir (default ~/.huddle-dev, env HUDDLE_DEV_HOME)
  --api-port <port>       portal/API port (default ${DEFAULT_API_PORT}, env HUDDLE_API_PORT)
  --control-port <port>   control-channel port (default ${DEFAULT_CONTROL_PORT}, env HUDDLE_CONTROL_PORT)
  --yes, -y               (reset only) skip the confirmation prompt
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'up') return cmdUp(rest);
  if (cmd === 'logs') return cmdLogs(rest);
  if (cmd === 'reset') return cmdReset(rest);
  usage();
  process.exit(cmd ? 1 : 0);
}

main();
