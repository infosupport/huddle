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
export const MAX_FOLDER_ENTRIES = 2000;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const MAX_TOOL_TIMEOUT_MS = 15 * 60 * 1000;

export type ErrorCode = 'bad_request' | 'unknown_op' | 'not_found' | 'not_allowed' | 'tool_missing' | 'internal';

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
  tools: string[];
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
 * Writes JSON to `<file>.tmp` and renames it over `<file>`, so the other side
 * never reads a half-written file. Rename within one folder is atomic on every
 * platform, including across the Docker bind mount.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
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
