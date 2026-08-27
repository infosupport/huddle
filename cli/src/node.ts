// `huddle node` — run Huddle Node (the control plane) directly on the host.
//
// Huddle Node is the half of Huddle that has no business being behind the
// firewall it configures: the portal, the REST/WS API, project + devcontainer
// orchestration, extensions and sbx. huddle-gateway keeps the other half — the
// filtering proxies devcontainers are DNAT'ed to. See
// docs/ADR-huddle-node-split.md; this is step 3 and is purely additive: nothing
// calls it yet, and `huddle init` still starts the combined container.
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

export interface NodeOptions {
  /** Explicit path to the built Huddle Node entrypoint. */
  entry?: string;
  /** Port for the portal + API. Defaults to Huddle Node's own 24842. */
  port?: string;
  /** Where Huddle Node keeps its database, CA and config. Defaults to ~/.huddle. */
  dataDir?: string;
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

// The environment that turns a combined gateway process into a host-side Huddle
// Node: role=node drops the proxies, host mode moves every path off the
// container layout and onto ~/.huddle. Anything the caller already set wins, so
// an operator can still point a run at a different data dir or port.
export function nodeEnv(opts: NodeOptions, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, HUDDLE_ROLE: 'node', HUDDLE_HOST_MODE: '1' };
  if (opts.port) out.HUDDLE_API_PORT = opts.port;
  if (opts.dataDir) out.HUDDLE_DATA_DIR = path.resolve(opts.dataDir);
  return out;
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

  // Foreground on purpose: lifecycle management (background, restart, single
  // instance, log files) is step 6, where `huddle init` starts both halves.
  // stdio inherit so the gateway's own logging is what the operator sees.
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
