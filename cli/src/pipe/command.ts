// ── `huddle pipe serve|start|stop|status` ─────────────────────────────────────
// Runs and manages the host agent for the host pipe (docs/host-pipe.md).
// `huddle init` calls startPipeAgent() so the agent always runs the CLI version
// that was just installed; the commands here are for checking on it and for
// debugging (`serve` runs it in the foreground with the log on the terminal).

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { dim, green, yellow } from '../utils';
import { HEARTBEAT_FILE, Heartbeat, LOG_FILE, PIPE_DIR, ensurePrivateDir, heartbeatFresh, readHeartbeat } from './protocol';
import { servePipe } from './serve';

const LOG_PATH = path.join(PIPE_DIR, LOG_FILE);
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const STOP_WAIT_MS = 3000;
const START_WAIT_MS = 3000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/**
 * Stops the agent named in the heartbeat. Only a FRESH heartbeat is trusted:
 * pids get reused, and killing whatever now holds the pid of an agent that died
 * last week would be a nasty surprise. A stale heartbeat is just removed.
 */
async function stopRunning(): Promise<Heartbeat | null> {
  const hb = readHeartbeat();
  if (!hb || !heartbeatFresh(hb) || hb.pid === process.pid || !alive(hb.pid)) {
    try { fs.unlinkSync(path.join(PIPE_DIR, HEARTBEAT_FILE)); } catch { /* none */ }
    return null;
  }
  try { process.kill(hb.pid, 'SIGTERM'); } catch { /* exited meanwhile */ }
  if (!(await waitFor(() => !alive(hb.pid), STOP_WAIT_MS))) {
    try { process.kill(hb.pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
    await waitFor(() => !alive(hb.pid), 1000);
  }
  // On Windows kill() is TerminateProcess, so the agent had no chance to clean up.
  const left = readHeartbeat();
  if (left?.pid === hb.pid) {
    try { fs.unlinkSync(path.join(PIPE_DIR, HEARTBEAT_FILE)); } catch { /* none */ }
  }
  return hb;
}

/** Keeps one previous log; the agent appends for as long as it runs. */
function rotateLog(): void {
  try {
    if (fs.statSync(LOG_PATH).size > MAX_LOG_BYTES) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch { /* no log yet */ }
}

export interface PipeStartResult {
  ok: boolean;
  pid?: number;
  replaced?: number;
  error?: string;
}

/**
 * Starts the agent in the background, replacing a running one so the agent
 * always runs this CLI's code. Never throws: `huddle init` must not fail on it.
 */
export async function startPipeAgent(): Promise<PipeStartResult> {
  try {
    ensurePrivateDir(PIPE_DIR);
    const old = await stopRunning();
    rotateLog();

    // dist/pipe/command.js -> dist/index.js: the entry of THIS install, not
    // whatever `huddle` resolves to on PATH.
    const entry = path.join(__dirname, '..', 'index.js');
    const logFd = fs.openSync(LOG_PATH, 'a', 0o600);
    let pid: number | undefined;
    try {
      const child = spawn(process.execPath, [entry, 'pipe', 'serve'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
      child.on('error', () => { /* reported below as "did not come up" */ });
      child.unref();
      pid = child.pid;
    } finally {
      fs.closeSync(logFd);
    }
    if (!pid) return { ok: false, error: `could not start the host agent (see ${LOG_PATH})` };

    const up = await waitFor(() => {
      const hb = readHeartbeat();
      return hb !== null && heartbeatFresh(hb) && hb.pid === pid;
    }, START_WAIT_MS);
    if (!up) return { ok: false, pid, error: `the host agent did not report in (see ${LOG_PATH})` };
    return { ok: true, pid, replaced: old?.pid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function runServe(): void {
  const stamp = () => new Date().toISOString();
  const log = (msg: string) => console.log(`${stamp()} ${msg}`);
  log(`host pipe agent (pid ${process.pid}) serving ${PIPE_DIR}`);
  const handle = servePipe({ dir: PIPE_DIR, log, onReplaced: () => process.exit(0) });
  const shutdown = (signal: string) => {
    log(`${signal}: stopping`);
    // Removes host.json right away; in-flight requests are abandoned (the
    // gateway times them out) rather than holding up a stop.
    void handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

function runStatus(): void {
  const hb = readHeartbeat();
  if (hb && heartbeatFresh(hb)) {
    console.log(`${green('Host pipe: online')} ${dim(`(pid ${hb.pid}, CLI ${hb.version}, ${hb.platform})`)}`);
    console.log(dim(`  tools:   ${hb.tools.length ? hb.tools.join(', ') : 'none installed'}`));
    console.log(dim(`  started: ${hb.startedAt} · heartbeat ${ago(hb.updatedAt)}`));
  } else {
    const last = hb ? ` (last heartbeat ${ago(hb.updatedAt)}, pid ${hb.pid})` : '';
    console.log(`${yellow('Host pipe: offline')}${dim(last)}`);
    console.log(dim('  Start it with: huddle pipe start'));
  }
  console.log(dim(`  folder:  ${PIPE_DIR}`));
  console.log(dim(`  log:     ${LOG_PATH}`));
}

export async function runPipe(opts: { action?: string }): Promise<void> {
  const action = opts.action ?? 'status';
  if (action === 'serve') {
    runServe();
  } else if (action === 'start') {
    const r = await startPipeAgent();
    if (!r.ok) {
      console.error(yellow(`[!] ${r.error}`));
      process.exit(1);
    }
    const replaced = r.replaced ? `, replaced pid ${r.replaced}` : '';
    console.log(green('[OK] Host pipe started') + dim(` (pid ${r.pid}${replaced}) · log ${LOG_PATH}`));
  } else if (action === 'stop') {
    const stopped = await stopRunning();
    console.log(stopped ? `Host pipe stopped ${dim(`(pid ${stopped.pid})`)}` : dim('Host pipe was not running'));
  } else if (action === 'status') {
    runStatus();
  } else {
    console.error(`Unknown pipe subcommand: ${action}`);
    console.error('Usage: huddle pipe <status|start|stop|serve>');
    process.exit(1);
  }
}
