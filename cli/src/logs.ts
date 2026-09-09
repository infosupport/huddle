// `huddle logs` — the two halves' output, from one command.
//
// Huddle runs as two processes (docs/ADR-huddle-node-split.md) and each keeps
// its output somewhere else: Huddle Node appends stdout+stderr to
// ~/.huddle/node.log, the gateway container has whatever `docker logs` holds.
// Knowing that is not something an operator should have to look up, so this
// command reads both and says which is which.
//
// Reading is deliberately local: the log of a Node that failed to start is
// exactly the log you need, and asking the API for it would need the process
// this command exists to diagnose.

import fs from 'fs';
import { spawn } from 'child_process';
import { NODE_LOG_FILE, isNodePidAlive, readNodePid } from './node';
import { resolveRuntime } from './runtime';
import { bold, cyan, dim, red, yellow } from './utils';

export interface LogsOptions {
  lines?: string;
  follow?: boolean;
  node?: boolean;
  gateway?: boolean;
}

const GATEWAY_CONTAINER = 'huddle';

export function parseLines(raw: string | undefined): number {
  if (raw === undefined) return 200;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) {
    throw new Error(`Invalid --lines "${raw}": use a whole number between 1 and 100000.`);
  }
  return n;
}

/**
 * The last `lines` lines of a file, read from the END.
 *
 * node.log is append-only across restarts, so it grows without bound — reading
 * the whole thing into memory to throw away all but the tail is exactly the
 * wrong shape for the one file this command exists to read. Chunks are read
 * backwards until enough newlines have been seen.
 */
export function tailFile(file: string, lines: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null; // never started, or the log was cleaned up
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = 64 * 1024;
    let pos = size;
    let found = 0;
    let text = '';
    while (pos > 0 && found <= lines) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const part = buf.toString('utf8');
      found += (part.match(/\n/g) ?? []).length;
      text = part + text;
    }
    const all = text.split('\n');
    // A trailing newline makes the last element empty; drop it so `--lines 1`
    // shows the last real line rather than a blank.
    if (all[all.length - 1] === '') all.pop();
    return all.slice(-lines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function printNodeLog(lines: number): void {
  const pid = readNodePid();
  const state = pid === null
    ? dim('(no pid file — not started by `huddle init`)')
    : isNodePidAlive() ? dim(`(pid ${pid}, running)`) : yellow(`(pid ${pid}, NOT running)`);
  console.log(bold(`── Huddle Node — ${cyan(NODE_LOG_FILE)} ${state}`));
  const tail = tailFile(NODE_LOG_FILE, lines);
  if (tail === null) {
    console.log(dim('  No log file yet. `huddle init` starts Node and creates it;'));
    console.log(dim('  `huddle node` runs it in the foreground and prints here instead.'));
    return;
  }
  console.log(tail.trim() ? tail : dim('  (empty)'));
}

// The engine command, or null with a printed reason. Not being able to reach an
// engine must not fail `huddle logs`: node.log is often the half that explains
// why, and it has already been printed by the time this runs.
function engineCommand(): string | null {
  try {
    return resolveRuntime().name;
  } catch (err) {
    console.log(dim(`  No container runtime available: ${(err as Error).message.split('\n')[0]}`));
    return null;
  }
}

// `docker logs` and not the API: the gateway's own startup failures are the
// interesting case, and those never reach an HTTP endpoint.
async function printGatewayLog(lines: number): Promise<void> {
  console.log('');
  console.log(bold('── huddle-gateway'));
  const engine = engineCommand();
  if (!engine) return;
  console.log(dim(`   ${engine} logs ${GATEWAY_CONTAINER}`));
  await new Promise<void>((resolve) => {
    const child = spawn(engine, ['logs', '--tail', String(lines), GATEWAY_CONTAINER], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', (err) => {
      console.log(red(`  Could not run ${engine}: ${err.message}`));
      resolve();
    });
    child.on('close', () => resolve());
  });
}

/**
 * Follow both halves at once: `tail -f` on node.log, `docker logs -f` on the
 * gateway, each line prefixed so two interleaved streams stay readable. Ends on
 * Ctrl-C like every other follower.
 */
async function followBoth(lines: number, wantNode: boolean, wantGateway: boolean): Promise<void> {
  const children: ReturnType<typeof spawn>[] = [];

  if (wantNode) {
    console.log(dim(`── following ${NODE_LOG_FILE}`));
    // Start at the END of the file and print the tail once, so following does
    // not replay a log that has been growing across every restart.
    let pos = 0;
    try { pos = fs.statSync(NODE_LOG_FILE).size; } catch { /* not created yet */ }
    const initial = tailFile(NODE_LOG_FILE, lines);
    if (initial?.trim()) console.log(prefix('node', initial));
    // Polling, not fs.watch: on Windows a file appended to by a detached process
    // does not reliably raise watch events, and a 500ms poll on one file costs
    // nothing next to being silently stuck.
    const timer = setInterval(() => {
      let size: number;
      try { size = fs.statSync(NODE_LOG_FILE).size; } catch { return; }
      if (size <= pos) { pos = Math.min(pos, size); return; } // truncated or unchanged
      const buf = Buffer.alloc(size - pos);
      const fd = fs.openSync(NODE_LOG_FILE, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, pos); } finally { fs.closeSync(fd); }
      pos = size;
      const text = buf.toString('utf8').replace(/\n$/, '');
      if (text) console.log(prefix('node', text));
    }, 500);
    process.on('SIGINT', () => clearInterval(timer));
  }

  const engine = wantGateway ? engineCommand() : null;
  if (engine) {
    console.log(dim(`── following ${engine} logs -f ${GATEWAY_CONTAINER}`));
    const child = spawn(engine, ['logs', '-f', '--tail', String(lines), GATEWAY_CONTAINER], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (b: Buffer) => {
        const text = b.toString('utf8').replace(/\n$/, '');
        if (text) console.log(prefix('gateway', text));
      });
    }
    child.on('error', (err) => console.log(red(`  Could not run ${engine}: ${err.message}`)));
    children.push(child);
  }

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      for (const c of children) c.kill();
      resolve();
    });
  });
}

function prefix(who: 'node' | 'gateway', text: string): string {
  const tag = who === 'node' ? cyan('[node]   ') : dim('[gateway]');
  return text.split('\n').map((l) => `${tag} ${l}`).join('\n');
}

export async function runLogs(opts: LogsOptions): Promise<void> {
  const lines = parseLines(opts.lines);
  // Neither flag means both halves; either flag means only that one.
  const wantNode = opts.node === true || opts.gateway !== true;
  const wantGateway = opts.gateway === true || opts.node !== true;

  if (opts.follow) {
    await followBoth(lines, wantNode, wantGateway);
    return;
  }

  if (wantNode) printNodeLog(lines);
  if (wantGateway) await printGatewayLog(lines);
}
