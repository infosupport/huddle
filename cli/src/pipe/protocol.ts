// ── Host pipe: shared protocol bits ───────────────────────────────────────────
// The host pipe is a folder (~/.huddle/pipe on the host, /huddle-home/pipe in the
// gateway) through which the gateway asks the host for things it cannot do from
// inside its container. See docs/host-pipe.md — that file is the contract; the
// names and numbers below mirror it and must not drift.

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../config';

export const PROTOCOL_VERSION = 1;

/** Where the agent serves by default: inside the ~/.huddle mount the gateway already has. */
export const PIPE_DIR = path.join(CONFIG_DIR, 'pipe');
export const HEARTBEAT_FILE = 'host.json';
export const LOG_FILE = 'host.log';

export const POLL_MS = 100;
export const HEARTBEAT_MS = 2000;
/** The gateway calls the agent offline when the heartbeat is older than this. */
export const HEARTBEAT_STALE_MS = 10_000;
/** Leftover request/reply files older than this are deleted on start. */
export const STALE_FILE_MS = 60 * 60 * 1000;

export type ErrorCode = 'bad_request' | 'unknown_op' | 'internal';

export interface PipeRequest {
  v: number;
  op: string;
  args?: Record<string, unknown>;
}

export type PipeReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: ErrorCode; message: string } };

export interface Heartbeat {
  v: number;
  pid: number;
  version: string;
  platform: NodeJS.Platform;
  startedAt: string;
  updatedAt: string;
}

/** Thrown by an op handler to answer with `ok:false` and a specific code. */
export class PipeError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}

/**
 * Creates the pipe folder owner-only, or makes an existing one so. Whoever can
 * write a request into it can make the agent set up SSH, so on POSIX it
 * must be ours (not a symlink) and closed to everyone else, and its parent must
 * not let anyone else swap it out. Throws when that cannot be made true. On
 * Windows a folder under the user profile is private already.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const uid = process.getuid();
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory (a symlink is not accepted)`);
  if (st.uid !== uid) throw new Error(`${dir} belongs to uid ${st.uid}, not to you: refusing to use it as the host pipe`);
  // The parent: ours (then closed to writes by others), or root's and either not
  // writable by others or sticky (like /tmp), where nobody else can rename ours.
  const parent = path.dirname(dir);
  const ps = fs.statSync(parent);
  const pmode = ps.mode & 0o7777;
  if (ps.uid === uid) {
    if (pmode & 0o022) fs.chmodSync(parent, pmode & ~0o022);
  } else if (ps.uid !== 0 || ((pmode & 0o022) && !(pmode & 0o1000))) {
    throw new Error(`${parent} can be changed by other users: refusing to serve the host pipe below it`);
  }
  if ((fs.statSync(dir).mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * Writes JSON to `<file>.tmp` and renames it over `<file>`, so the other side
 * never reads a half-written file. Rename within one folder is atomic on every
 * platform, including across the Docker bind mount.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The heartbeat in `dir`, or null when there is none (or it is unreadable). */
export function readHeartbeat(dir: string = PIPE_DIR): Heartbeat | null {
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(dir, HEARTBEAT_FILE), 'utf8')) as Heartbeat;
    return typeof hb === 'object' && hb !== null && typeof hb.pid === 'number' ? hb : null;
  } catch {
    return null;
  }
}

/** Same rule as the gateway: online only while the heartbeat is younger than 10 s. */
export function heartbeatFresh(hb: Heartbeat, now: number = Date.now()): boolean {
  const updated = Date.parse(hb.updatedAt);
  return Number.isFinite(updated) && now - updated < HEARTBEAT_STALE_MS;
}
