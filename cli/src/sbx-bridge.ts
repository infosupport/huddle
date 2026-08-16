// ── sbx bridge watcher (CLI-native) ───────────────────────────────────────────
// The host half of the file mailbox, in Node so the CLI can start it (no bash
// dependency, cross-platform). It watches the shared bridge folder for request
// files the gateway container drops, runs the REAL `sbx` on the host, and writes
// the response back. Same protocol as bridge/sbx.sh + bridge/sbx-watcher.sh:
//   req/<id>.req  (argv, one per line)  →  res/<id>.out / .err / .code (code last)
// The folder is $HUDDLE_SBX_BRIDGE_WIN or ~/.huddle-sbx — the same dir `huddle
// init` bind-mounts into the gateway at /sbx-bridge.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, spawn, execFileSync } from 'child_process';
import { CONFIG_DIR } from './config';
import { dim, green, yellow } from './utils';

const BRIDGE = process.env.HUDDLE_SBX_BRIDGE_WIN?.trim() || path.join(os.homedir(), '.huddle-sbx');
const REQ = path.join(BRIDGE, 'req');
const RES = path.join(BRIDGE, 'res');
const PID_FILE = path.join(CONFIG_DIR, 'sbx-bridge.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'sbx-bridge.log');
const POLL_MS = Number(process.env.HUDDLE_SBX_BRIDGE_POLL_MS ?? '150');

/** Resolve the host sbx binary: HUDDLE_SBX_BIN, else `sbx`, else `sbx.exe`. */
// windowsHide stops a new console window from popping up for every child `sbx.exe`
// — the bridge is a detached (console-less) process, so without this Windows opens
// a terminal window on each spawn, and the poller spawns sbx frequently.
const NO_WINDOW = { windowsHide: true } as const;

export function resolveSbxBin(): string {
  const env = process.env.HUDDLE_SBX_BIN?.trim();
  if (env) return env;
  for (const c of ['sbx', 'sbx.exe']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore', timeout: 15000, ...NO_WINDOW }); return c; } catch { /* try next */ }
  }
  return 'sbx';
}

/** MSYS/git-bash path → Windows path (/t/proj → T:\proj) so `sbx create <ws>` works. */
function xlate(arg: string): string {
  if (process.platform !== 'win32' || process.env.HUDDLE_SBX_NO_PATH_XLATE === '1') return arg;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(arg);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : arg;
}

function readPid(): number | null {
  try { const p = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); return Number.isFinite(p) ? p : null; } catch { return null; }
}
function alive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function bridgeRunning(): boolean { return alive(readPid()); }

/** Foreground watch loop. Runs until killed. */
export function runBridge(): void {
  fs.mkdirSync(REQ, { recursive: true });
  fs.mkdirSync(RES, { recursive: true });
  const bin = resolveSbxBin();
  let ver = 'not found on PATH';
  try { ver = execFileSync(bin, ['version'], { timeout: 15000, ...NO_WINDOW }).toString().split(/\r?\n/)[0]; } catch { /* keep default */ }
  console.log(`[sbx-bridge] watching ${REQ}`);
  console.log(`[sbx-bridge] sbx = ${bin} (${ver})`);

  const tick = () => {
    let files: string[] = [];
    try { files = fs.readdirSync(REQ).filter((f) => f.endsWith('.req')); } catch { /* folder gone */ }
    for (const f of files) {
      const id = f.slice(0, -'.req'.length);
      const reqPath = path.join(REQ, f);
      let args: string[];
      try {
        args = fs.readFileSync(reqPath, 'utf8').split(/\r?\n/).filter((l) => l.length > 0).map(xlate);
      } catch { continue; }
      let out: Buffer = Buffer.alloc(0);
      let err: Buffer = Buffer.alloc(0);
      let code = 0;
      if (args.length === 0) { err = Buffer.from('empty request'); code = 2; }
      else {
        const r = spawnSync(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 300000, ...NO_WINDOW });
        out = (r.stdout as Buffer) ?? Buffer.alloc(0);
        err = (r.stderr as Buffer) ?? Buffer.alloc(0);
        if (r.error) { err = Buffer.from(String((r.error as NodeJS.ErrnoException).code === 'ENOENT' ? `'${bin}' not found on PATH` : r.error.message)); code = 127; }
        else code = r.status ?? 0;
      }
      try {
        fs.writeFileSync(path.join(RES, `${id}.out`), out);
        fs.writeFileSync(path.join(RES, `${id}.err`), err);
        const tmp = path.join(RES, `${id}.code.tmp`);
        fs.writeFileSync(tmp, String(code));
        fs.renameSync(tmp, path.join(RES, `${id}.code`)); // completion marker, written last
      } catch { /* best effort */ }
      finally { try { fs.unlinkSync(reqPath); } catch { /* ignore */ } }
      console.log(`[sbx-bridge] ${id}: ${args.join(' ') || '<empty>'} -> exit ${code}`);
    }
    setTimeout(tick, POLL_MS);
  };
  const shutdown = () => { console.log('[sbx-bridge] stopping'); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  tick();
}

/** Start the watcher detached in the background (idempotent). */
export function startBridge(opts: { quiet?: boolean } = {}): void {
  if (bridgeRunning()) { if (!opts.quiet) console.log(dim(`sbx bridge already running (pid ${readPid()})`)); return; }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(REQ, { recursive: true });
  fs.mkdirSync(RES, { recursive: true });
  const outFd = fs.openSync(LOG_FILE, 'a');
  const entry = process.argv[1]; // this CLI's dist/index.js
  const child = spawn(process.execPath, [entry, 'sbx', 'bridge', 'run'], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: process.env,
    windowsHide: true,
  });
  if (child.pid) fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(green(`✓ sbx bridge started`) + dim(` (pid ${child.pid}) watching ${BRIDGE} · log ${LOG_FILE}`));
}

export function stopBridge(): void {
  const pid = readPid();
  if (!alive(pid)) { console.log(dim('sbx bridge not running')); try { fs.unlinkSync(PID_FILE); } catch {} return; }
  try { process.kill(pid as number); } catch { /* ignore */ }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  console.log('sbx bridge stopped');
}

export function bridgeStatus(): void {
  if (bridgeRunning()) console.log(green(`sbx bridge running`) + dim(` (pid ${readPid()}) · folder ${BRIDGE} · log ${LOG_FILE}`));
  else console.log(yellow('sbx bridge not running') + dim(` — start it with: huddle sbx bridge`));
}
