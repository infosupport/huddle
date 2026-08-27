// Huddle Node — the control plane, running directly on the host.
//
// Huddle Node is the half of Huddle that has no business being behind the
// firewall it configures: the portal, the REST/WS API, project + devcontainer
// orchestration, extensions and sbx. huddle-gateway keeps the other half — the
// filtering proxies devcontainers are DNAT'ed to (docs/ADR-huddle-node-split.md).
//
// Two entry points live here. `huddle node` runs it in the FOREGROUND, which is
// what you want when you are working on Huddle itself: logs on your terminal,
// Ctrl-C stops it. `huddle init` calls startNodeDetached() instead, because an
// init that only survives as long as the terminal it was typed in is not an
// init at all.
//
// PACKAGING GAP (deliberately not solved here)
//   This command runs an EXISTING Huddle Node build; it cannot produce one. The
//   published CLI ships only its own dist and has zero dependencies, while
//   Huddle Node needs fastify, dockerode and better-sqlite3 — the last a native
//   module needing prebuilds per platform. Deciding how a released Huddle Node
//   reaches the host (bundled in the CLI package, a separate npm package, or
//   extracted from the gateway image) is its own step. Until then this resolves
//   a local build, which is what a repo checkout and `huddle init` in dev mode
//   both already have.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { bold, cyan, dim, red, yellow } from './utils';
import { CONFIG_DIR } from './config';

export interface NodeOptions {
  /** Explicit path to the built Huddle Node entrypoint. */
  entry?: string;
  /** Port for the portal + API. Defaults to Huddle Node's own 24842. */
  port?: string;
  /** Where Huddle Node keeps its database, CA and config. Defaults to ~/.huddle. */
  dataDir?: string;
  /** Interface the control channel binds. Defaults to loopback. */
  controlHost?: string;
  /** Operator token to run with. `huddle init` passes the one it stores for the CLI. */
  operatorToken?: string;
  /** Extra environment (base-image overrides during an experiment). */
  extraEnv?: NodeJS.ProcessEnv;
}

export const DEFAULT_NODE_PORT = 24842;

// An explicitly named entry, if there is one. Resolved separately from the
// search path on purpose: naming a build is a claim about which one to run, so
// a missing file has to fail loudly rather than quietly starting a different
// build that happens to exist elsewhere.
export function explicitNodeEntry(opts: NodeOptions, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = opts.entry ?? env.HUDDLE_NODE_ENTRY;
  return explicit ? path.resolve(explicit) : null;
}

// Where to look when nothing was named. Pure, so the search order is testable
// without a filesystem full of fixtures.
export function nodeEntryCandidates(cliDir: string): string[] {
  // A repo checkout: cli/dist/index.js → ../../gateway/dist/index.js, and the
  // same one level up for layouts that nest the build one deeper.
  return [
    path.resolve(cliDir, '..', '..', 'gateway', 'dist', 'index.js'),
    path.resolve(cliDir, '..', '..', '..', 'gateway', 'dist', 'index.js'),
  ];
}

export class MissingNodeEntryError extends Error {
  constructor(readonly entry: string) {
    super(`No Huddle Node build at ${entry}`);
  }
}

// Returns the entry to run, or null when nothing was named and nothing was
// found. Throws MissingNodeEntryError when something WAS named but is absent.
export function resolveNodeEntry(opts: NodeOptions, cliDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = explicitNodeEntry(opts, env);
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new MissingNodeEntryError(explicit);
    return explicit;
  }
  for (const c of nodeEntryCandidates(cliDir)) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// The environment that makes this process Huddle Node. The role IS the
// deployment (gateway/src/runtime-env.ts): `node` drops the proxies and moves
// every path off the container layout onto ~/.huddle. Anything the caller
// already set wins, so an operator can still point a run at a different data
// dir or port.
export function nodeEnv(opts: NodeOptions, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, HUDDLE_ROLE: 'node' };
  if (opts.port) out.HUDDLE_API_PORT = opts.port;
  if (opts.dataDir) out.HUDDLE_DATA_DIR = path.resolve(opts.dataDir);
  // Where the GATEWAY container will reach the control channel. Loopback is the
  // default and stays it on Docker Desktop; on native Linux `huddle init` passes
  // the bridge address here, because a container cannot reach the host's
  // loopback there. See cli/src/control-address.ts.
  if (opts.controlHost) out.HUDDLE_CONTROL_HOST = opts.controlHost;
  if (opts.operatorToken) out.HUDDLE_OPERATOR_TOKEN = opts.operatorToken;
  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) out[k] = v;
  return out;
}

/**
 * Where Huddle Node keeps its state. Mirrors `dataDir` in
 * gateway/src/runtime-env.ts — the CLI has to be able to name the same
 * directories the process it just spawned will use.
 */
export function nodeDataDir(opts: NodeOptions = {}, env: NodeJS.ProcessEnv = process.env): string {
  if (opts.dataDir) return path.resolve(opts.dataDir);
  return env.HUDDLE_DATA_DIR?.trim() || path.join(os.homedir(), '.huddle');
}

/**
 * The MITM CA directory — its own subdirectory of the data dir, and that is what
 * makes it mountable: `huddle init` binds exactly this into the gateway
 * read-only, while the database and the operator token stay behind.
 */
export function nodeCaDir(opts: NodeOptions = {}, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(nodeDataDir(opts, env), 'ca');
}

/** The operator token Huddle Node persisted, or null if it has not written one. */
export function readOperatorToken(dataDir: string = nodeDataDir()): string | null {
  try {
    return fs.readFileSync(path.join(dataDir, 'operator-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * The gateway token Huddle Node runs with — the narrow, machine-to-machine
 * credential for the control channel (gateway/src/auth.ts). Node writes it into
 * its data dir on first boot, so this is only readable AFTER Node is up.
 *
 * Deliberately not generated here. One writer for a secret means there is never
 * a question of which copy is real.
 */
export function readGatewayToken(dataDir: string): string {
  const fromEnv = process.env.HUDDLE_GATEWAY_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return fs.readFileSync(path.join(dataDir, 'gateway-token'), 'utf8').trim();
}

export async function runNode(opts: NodeOptions = {}): Promise<void> {
  let entry: string | null;
  try {
    entry = resolveNodeEntry(opts, __dirname);
  } catch (err) {
    if (!(err instanceof MissingNodeEntryError)) throw err;
    console.error(red(err.message));
    console.error(dim('  Named explicitly, so no other build was tried.'));
    process.exit(1);
  }
  if (!entry) {
    console.error(red('No Huddle Node build found.'));
    console.error('');
    console.error('  `huddle node` runs an existing build; it does not create one.');
    console.error('  In a repo checkout, build it first:');
    console.error(cyan('    npm --prefix gateway install && npm --prefix gateway run build'));
    console.error('');
    console.error('  Or point at a build explicitly:');
    console.error(cyan('    huddle node --entry /path/to/gateway/dist/index.js'));
    console.error(dim('  (or set HUDDLE_NODE_ENTRY)'));
    process.exit(1);
  }

  const env = nodeEnv(opts);
  const port = env.HUDDLE_API_PORT ?? String(DEFAULT_NODE_PORT);

  console.log(bold('Huddle Node') + dim(' — control plane, on this host'));
  console.log(`  entry  ${dim(entry)}`);
  console.log(`  portal ${cyan(`http://localhost:${port}`)}`);
  console.log(`  data   ${dim(env.HUDDLE_DATA_DIR ?? path.join(os.homedir(), '.huddle'))}`);
  console.log('');
  console.log(yellow('  The firewall still lives in huddle-gateway; this process does not enforce it.'));
  console.log(dim('  Ctrl-C to stop.'));
  console.log('');

  // Foreground on purpose: this is the shape you want while working ON Huddle.
  // `huddle init` uses startNodeDetached() below. stdio inherit so Huddle Node's
  // own logging is what the operator sees.
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [entry], { env, stdio: 'inherit' });

    // Forward the signals an operator actually sends, so Ctrl-C stops Huddle
    // Node rather than orphaning it behind a dead CLI.
    const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* already gone */ } };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    child.on('error', (err) => {
      console.error(red(`Failed to start Huddle Node: ${err.message}`));
      process.exitCode = 1;
      resolve();
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      if (signal) console.log(dim(`\nHuddle Node stopped (${signal}).`));
      else if (code) process.exitCode = code;
      resolve();
    });
  });
}

// ── Detached lifecycle (what `huddle init` uses) ─────────────────────────────
//
// Huddle Node has to outlive the shell `huddle init` was typed in, so init
// spawns it detached and remembers the pid. Two files in ~/.huddle: the pid, and
// a log, because a background process with nowhere to write its output is a
// process you cannot debug.
//
// The pid file is a hint, not a lock. A pid can be recycled, so isNodeRunning()
// treats it as "worth probing" and the HTTP health check is what actually
// decides whether Huddle Node is up — see waitForNode().

export const NODE_PID_FILE = path.join(CONFIG_DIR, 'node.pid');
export const NODE_LOG_FILE = path.join(CONFIG_DIR, 'node.log');

/** The URL a HUMAN talks to Huddle Node on: printed, opened in a browser. */
export function nodeUrl(port: number | string = DEFAULT_NODE_PORT): string {
  return `http://localhost:${port}`;
}

/**
 * The addresses the CLI itself talks to Huddle Node on — loopback literals, in
 * order, not the name `localhost`.
 *
 * Node binds ONE address (runtime-env.ts's apiBindHost: 127.0.0.1 in host mode),
 * while `localhost` is two — and on Windows it resolves to ::1 first, where
 * nothing listens. A browser papers over that with Happy Eyeballs, and so does a
 * recent enough Node; an older one just fails. That combination is nasty,
 * because it makes Huddle look half-installed rather than broken: the portal
 * opens fine, but `huddle init` sits out its 30s probe against a perfectly
 * healthy process and exits BEFORE it ever creates the gateway container.
 *
 * So probe the literals and accept whichever answers. HUDDLE_API_HOST wins when
 * set, since then Node is not on loopback at all.
 */
export function nodeProbeUrls(port: number | string = DEFAULT_NODE_PORT): string[] {
  const bound = process.env.HUDDLE_API_HOST?.trim();
  if (bound && bound !== '0.0.0.0' && bound !== '::') {
    const host = bound.includes(':') && !bound.startsWith('[') ? `[${bound}]` : bound;
    return [`http://${host}:${port}`];
  }
  return [`http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}

export function readNodePid(): number | null {
  try {
    const pid = Number(fs.readFileSync(NODE_PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Does the recorded pid still name a live process? Says nothing about whether it is Huddle Node. */
export function isNodePidAlive(): boolean {
  const pid = readNodePid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is Huddle Node answering? /api/auth/status is the probe: it needs no operator
 * token (api.ts keeps it public so the portal can find out whether login is
 * needed), so a 200 here means the API is up, not merely that a port is open.
 */
export async function pingNode(port: number | string, timeoutMs = 1500): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (const base of nodeProbeUrls(port)) {
      try {
        const res = await fetch(`${base}/api/auth/status`, { signal: ac.signal });
        if (res.ok) return true;
      } catch {
        // Wrong family, or not up yet. Try the next address, then the next tick.
      }
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForNode(port: number | string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pingNode(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export interface StartedNode {
  pid: number;
  entry: string;
  port: string;
  /** True when Huddle Node was already running and nothing new was spawned. */
  reused: boolean;
}

export async function stopNode(): Promise<boolean> {
  const pid = readNodePid();
  if (pid === null) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone. Clearing the pid file below is still the right cleanup.
  }
  try { fs.unlinkSync(NODE_PID_FILE); } catch { /* nothing to clean up */ }
  return true;
}

/**
 * Start Huddle Node in the background and wait until it answers.
 *
 * Refuses to spawn a second one: two Huddle Nodes on one machine would both open
 * the same SQLite file and both hand the gateway a policy feed, and only one of
 * them would own the port. If one is already answering, that one is used.
 */
export async function startNodeDetached(opts: NodeOptions = {}): Promise<StartedNode> {
  const env = nodeEnv(opts);
  const port = env.HUDDLE_API_PORT ?? String(DEFAULT_NODE_PORT);

  if (await pingNode(port)) {
    return { pid: readNodePid() ?? 0, entry: '(already running)', port, reused: true };
  }

  const entry = resolveNodeEntry(opts, __dirname);
  if (!entry) throw new MissingNodeEntryError(nodeEntryCandidates(__dirname)[0]);

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Append, not truncate: the log of the run that just failed is usually the
  // thing you need after a restart.
  const log = fs.openSync(NODE_LOG_FILE, 'a');
  const child = spawn(process.execPath, [entry], {
    env,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);

  if (child.pid) fs.writeFileSync(NODE_PID_FILE, String(child.pid));

  if (!(await waitForNode(port))) {
    // Alive-but-unreachable and dead are different bugs with the same symptom,
    // and the difference is the first thing you want to know: init stops here,
    // so the gateway container is never created and Huddle looks half-installed.
    const stillRunning = child.pid ? isNodePidAlive() : false;
    throw new Error(
      `Huddle Node did not come up on ${nodeProbeUrls(port).join(' or ')} within 30s.\n` +
      (stillRunning
        ? `  The process (pid ${child.pid}) is still running, so it started but is not answering there.\n`
        : `  The process is gone, so it failed during startup.\n`) +
      `  Check ${NODE_LOG_FILE} — it holds everything the process printed.`,
    );
  }

  return { pid: child.pid ?? 0, entry, port, reused: false };
}
