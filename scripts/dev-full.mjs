#!/usr/bin/env node
/**
 * Runs a second, fully independent Huddle STACK next to a real (daily-driver)
 * install — its own huddle-gateway container, its own devcontainer network,
 * its own Docker-socket directory, its own Huddle Node — so devcontainers
 * created under one stack never see or get rewired by the other.
 *
 * This is the full counterpart to dev-single.mjs, which deliberately stays
 * Node-only and never launches a gateway (see its header comment). This
 * script is what dev-single.mjs's header describes as "investigated and
 * deliberately not pursued" for THAT tool — it lives here instead, as its
 * own script, so dev-single.mjs stays the simple one-process tool it was
 * designed to be.
 *
 * How the isolation works, on top of dev-single.mjs's HOME trick:
 *   - HOME (and win32's USERPROFILE/HOMEDRIVE/HOMEPATH) isolates
 *     ~/.huddle — config.json, node.pid, node.log, the operator token —
 *     exactly as in dev-single.mjs. See cli/src/config.ts CONFIG_DIR.
 *   - HUDDLE_INSTANCE (cli/src/init.ts resolveInstance()) suffixes the
 *     gateway container name, the devcontainer network name and the
 *     Docker-socket directory, so this stack's `huddle init` never touches
 *     the real install's "huddle" container/network/sockets.
 *   - HUDDLE_PORT / HUDDLE_CONTROL_PORT / HUDDLE_SBX_PROXY_PORT move every
 *     TCP port this stack binds off the real install's ports.
 *
 * The operator token is deliberately NOT isolated along with everything
 * else: both stacks' portals live on http://localhost, just different
 * ports, and a browser cookie is scoped by (domain, path) only — never by
 * port (RFC 6265) — so two different tokens on two localhost ports fight
 * over the same cookie and keep logging each other out. Simplest fix is to
 * not have two tokens: realOperatorToken() reads the token already sitting
 * in the REAL ~/.huddle/config.json (if `huddle init` has been run there at
 * least once) and this stack's `huddle init` is handed that same token via
 * HUDDLE_OPERATOR_TOKEN, which gateway/src/auth.ts treats as authoritative
 * — so both stacks end up authenticating with the identical token and
 * either portal tab logs both in. Falls back to letting this stack mint its
 * own token, as before, when the real install has never been initialized.
 *
 * Unlike dev-single.mjs's `up` (which drives `huddle node` and blocks in the
 * foreground), this drives `huddle init`, which starts Node detached, brings
 * up the gateway container and then RETURNS — so `up` here is a one-shot
 * command, not a long-running foreground process. `down` is the necessary
 * counterpart dev-single.mjs never needed (it never created Docker
 * resources to tear down).
 *
 * Subcommands:
 *   up      builds gateway+cli if needed, then runs `huddle init` against
 *           the isolated HOME/instance. Prints the portal URL and returns.
 *   logs    runs `huddle logs --follow` against the isolated HOME/instance
 *           (shows both the Node and gateway halves — see cli/src/logs.ts).
 *   down    stops this instance's detached Node (via its pid file) and
 *           removes its gateway container + devcontainer network.
 *   reset   down, then deletes the isolated HOME dir. Refuses if it
 *           resolves to your real ~/.huddle or to $HOME itself, and asks
 *           for confirmation unless you pass --yes.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_INSTANCE = 'sbx';
const DEFAULT_PORT = '26842';
const DEFAULT_CONTROL_PORT = '26843';
const DEFAULT_SBX_PROXY_PORT = '33768';
const DEFAULT_HOME = path.join(os.homedir(), '.huddle-dev-full');

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

// Resolution order matches dev-single.mjs: an explicit flag wins, then the
// env var, then the default.
function resolveDevHome(args) {
  const value = flagValue(args, '--home') ?? process.env.HUDDLE_DEV_HOME ?? DEFAULT_HOME;
  return path.resolve(value);
}

function resolveInstance(args) {
  return flagValue(args, '--instance') ?? process.env.HUDDLE_INSTANCE ?? DEFAULT_INSTANCE;
}

function resolvePort(args) {
  return flagValue(args, '--port') ?? process.env.HUDDLE_PORT ?? DEFAULT_PORT;
}

function resolveControlPort(args) {
  return flagValue(args, '--control-port') ?? process.env.HUDDLE_CONTROL_PORT ?? DEFAULT_CONTROL_PORT;
}

function resolveSbxProxyPort(args) {
  return flagValue(args, '--sbx-proxy-port') ?? process.env.HUDDLE_SBX_PROXY_PORT ?? DEFAULT_SBX_PROXY_PORT;
}

/**
 * The operator token already sitting in the REAL (daily-driver) install's
 * config — read with the process's own, un-overridden os.homedir(), i.e.
 * before childEnv() below ever points HOME at the isolated dir. Returns
 * undefined when the real install has never run `huddle init` (no
 * ~/.huddle/config.json yet, or no operatorToken field in it) — callers
 * fall back to the old per-stack-generates-its-own-token behavior then.
 */
function realOperatorToken() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.huddle', 'config.json'), 'utf8');
    const token = JSON.parse(raw).operatorToken;
    return typeof token === 'string' && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The env to spawn the isolated Huddle CLI under. Same HOME/USERPROFILE/
 * HOMEDRIVE/HOMEPATH dance as dev-single.mjs's childEnv() (see its header
 * comment for why win32 needs all three) plus HUDDLE_INSTANCE, which is
 * what actually gets this stack its own gateway container/network/socket
 * dir (cli/src/init.ts resolveInstance()). No HUDDLE_SKIP_GATEWAY_WIRING
 * here: unlike dev-single.mjs, this instance DOES have its own gateway and
 * is supposed to wire its own devcontainers to it.
 *
 * HUDDLE_OPERATOR_TOKEN: an explicit env/--token value the caller already
 * set wins outright (an operator naming their own token is not ours to
 * overrule); otherwise default to the real install's token (see the header
 * comment for why — same token, not an isolated one, is the point here).
 */
function childEnv(devHome, instance, port, controlPort, sbxProxyPort) {
  const env = {
    ...process.env,
    HOME: devHome,
    HUDDLE_INSTANCE: instance,
    HUDDLE_PORT: port,
    HUDDLE_CONTROL_PORT: controlPort,
    HUDDLE_SBX_PROXY_PORT: sbxProxyPort,
  };
  const operatorToken = process.env.HUDDLE_OPERATOR_TOKEN?.trim() || realOperatorToken();
  if (operatorToken) env.HUDDLE_OPERATOR_TOKEN = operatorToken;
  if (process.platform === 'win32') {
    env.USERPROFILE = devHome;
    env.HOMEDRIVE = devHome.slice(0, 2);
    env.HOMEPATH = devHome.slice(2);
  }
  return env;
}

/** Same as dev-single.mjs's ensureBuilt(): always rebuilds, no dist/-exists
 * shortcut, so `up` runs what's actually in the checkout right now. */
function ensureBuilt(name, entryFile) {
  console.log(`> building ${name}`);
  const script = name === 'gateway' ? 'build' : 'cli:build';
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

function guardDevHome(devHome) {
  const realHome = path.join(os.homedir(), '.huddle');
  if (devHome === realHome || devHome === os.homedir()) {
    console.error(`Refusing: --home/HUDDLE_DEV_HOME resolves to ${devHome}.`);
    console.error('This would run the second stack against your daily-driver data. Pick a different --home.');
    process.exit(1);
  }
}

function runCli(args, env, opts = {}) {
  const cliEntry = path.join(ROOT, 'cli', 'dist', 'index.js');
  return spawnSync(process.execPath, [cliEntry, ...args], { cwd: ROOT, env, stdio: 'inherit', ...opts });
}

function cmdUp(args) {
  const devHome = resolveDevHome(args);
  const instance = resolveInstance(args);
  const port = resolvePort(args);
  const controlPort = resolveControlPort(args);
  const sbxProxyPort = resolveSbxProxyPort(args);

  guardDevHome(devHome);
  fs.mkdirSync(devHome, { recursive: true, mode: 0o700 });

  ensureBuilt('gateway', path.join(ROOT, 'gateway', 'dist', 'index.js'));
  ensureBuilt('cli', path.join(ROOT, 'cli', 'dist', 'index.js'));

  const env = childEnv(devHome, instance, port, controlPort, sbxProxyPort);

  console.log('');
  console.log(`Huddle (second stack, instance "${instance}") — independent from your real install`);
  console.log(`  home       ${devHome}`);
  console.log(`  container  huddle-${instance}`);
  console.log(`  network    devcontainer-net-${instance}`);
  console.log(`  portal     http://localhost:${port}`);
  console.log(`  control    ${controlPort}`);
  console.log('');

  const { status } = runCli(['init'], env);
  process.exitCode = status ?? 0;
}

function cmdLogs(args) {
  const devHome = resolveDevHome(args);
  const instance = resolveInstance(args);
  const env = childEnv(devHome, instance, resolvePort(args), resolveControlPort(args), resolveSbxProxyPort(args));
  const { status } = runCli(['logs', '--follow'], env);
  process.exitCode = status ?? 0;
}

// There is no `huddle` subcommand to stop a detached Node (cli/src/index.ts
// has no such flag — `restart` just re-runs `init`), so this reimplements
// the pid-file kill directly: same path cli/src/node.ts's NODE_PID_FILE
// derives (CONFIG_DIR = path.join(os.homedir(), '.huddle'), and HOME is
// pinned to devHome by childEnv()), same liveness check via signal 0.
function stopDetachedNode(devHome) {
  const pidFile = path.join(devHome, '.huddle', 'node.pid');
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  } catch {
    console.log('  no pid file — Node was not started by `huddle init`, or already cleaned up');
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    console.log(`  pid file ${pidFile} did not contain a valid pid`);
    return;
  }
  try {
    process.kill(pid, 0); // liveness check only, no signal actually sent
  } catch {
    console.log(`  pid ${pid} (from ${pidFile}) is not running`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`  sent SIGTERM to pid ${pid}`);
  } catch (err) {
    console.error(`  could not stop pid ${pid}: ${err.message}`);
  }
}

function cmdDown(args) {
  const devHome = resolveDevHome(args);
  const instance = resolveInstance(args);

  console.log(`> stopping Huddle Node (instance "${instance}")`);
  stopDetachedNode(devHome);

  const container = `huddle-${instance}`;
  const network = `devcontainer-net-${instance}`;
  for (const runtime of ['docker', 'podman']) {
    const check = spawnSync(runtime, ['version'], { stdio: 'ignore' });
    if (check.error) continue; // runtime not installed — try the next one
    console.log(`> ${runtime} rm -f ${container}`);
    spawnSync(runtime, ['rm', '-f', container], { stdio: 'inherit' });
    console.log(`> ${runtime} network rm ${network}`);
    spawnSync(runtime, ['network', 'rm', network], { stdio: 'inherit' });
    break;
  }

  const socketDir = `/tmp/dc-sockets-${instance}`;
  if (fs.existsSync(socketDir)) {
    console.log(`> removing ${socketDir}`);
    try {
      fs.rmSync(socketDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`  could not remove ${socketDir}: ${err.message} (it's root-owned when a gateway created it — sudo rm -rf it manually if needed)`);
    }
  }
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
  guardDevHome(devHome);

  if (!hasFlag(args, '--yes') && !hasFlag(args, '-y')) {
    const ok = await confirm(`Tear down this stack and delete ${devHome} and everything in it? [y/N] `);
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  cmdDown(args);

  if (!fs.existsSync(devHome)) {
    console.log(`Nothing more to remove: ${devHome} does not exist.`);
    return;
  }
  fs.rmSync(devHome, { recursive: true, force: true });
  console.log(`Removed ${devHome}.`);
}

function usage() {
  console.log(`Usage: npm run dev:full -- <up|logs|down|reset> [options]

  up      rebuild gateway+cli, then run \`huddle init\` — starts Node
          detached and its own gateway container, then returns
  logs    run \`huddle logs --follow\` against this instance (both halves)
  down    stop this instance's Node and remove its gateway container +
          devcontainer network
  reset   down, then delete the isolated HOME dir (asks for confirmation)

Options:
  --home <path>              isolated HOME dir (default ~/.huddle-dev-full, env HUDDLE_DEV_HOME)
  --instance <name>          gateway/network/socket-dir suffix (default ${DEFAULT_INSTANCE}, env HUDDLE_INSTANCE)
  --port <port>               portal/API port (default ${DEFAULT_PORT}, env HUDDLE_PORT)
  --control-port <port>       control-channel port (default ${DEFAULT_CONTROL_PORT}, env HUDDLE_CONTROL_PORT)
  --sbx-proxy-port <port>     sbx egress port (default ${DEFAULT_SBX_PROXY_PORT}, env HUDDLE_SBX_PROXY_PORT)
  --yes, -y                   (reset only) skip the confirmation prompt
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'up') return cmdUp(rest);
  if (cmd === 'logs') return cmdLogs(rest);
  if (cmd === 'down') return cmdDown(rest);
  if (cmd === 'reset') return cmdReset(rest);
  usage();
  process.exit(cmd ? 1 : 0);
}

main();
