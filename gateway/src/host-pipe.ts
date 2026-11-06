// Gateway side of the host pipe (docs/host-pipe.md).
//
// The gateway runs in a container and cannot see or run anything on the host.
// The host agent (`huddle pipe serve`) watches a folder inside the already
// mounted ~/.huddle; we talk to it by dropping request files there and polling
// for the reply. A folder and not a socket because plain files are the one thing
// that crosses a Docker bind mount on every platform.
//
// One request:
//   1. write <id>.in.tmp, rename to <id>.in (atomic: the agent never sees half a file)
//   2. the agent claims it by renaming <id>.in → <id>.busy, runs it, writes <id>.out
//   3. we read and delete <id>.out
// An .in nobody claims within CLAIM_TIMEOUT_MS means no agent is listening
// (host_pipe_offline); a claimed request without reply within the op's timeout
// is host_pipe_timeout.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const HOME_DIR = process.env.HUDDLE_HOME_DIR || '/huddle-home';

export type HostPipeErrorCode =
  | 'bad_request'
  | 'unknown_op'
  | 'not_found'
  | 'not_allowed'
  | 'tool_missing'
  | 'internal'
  | 'host_pipe_offline'
  | 'host_pipe_timeout';

export class HostPipeError extends Error {
  constructor(public readonly code: HostPipeErrorCode | string, message?: string) {
    super(message || code);
    this.name = 'HostPipeError';
  }
}

// What GET /api/host-pipe reports: the heartbeat the agent writes every 2 s.
export interface HostPipeStatus {
  online: boolean;
  version?: string;
  platform?: string;
  tools?: string[];
  updatedAt?: string;
}

export interface HostPipeOptions {
  dir?: string;
  claimTimeoutMs?: number;   // unclaimed .in → offline
  defaultTimeoutMs?: number; // claimed, no .out → timeout
  maxTimeoutMs?: number;     // cap on any per-call timeout
  staleMs?: number;          // heartbeat older than this → offline
  pollMs?: number;
}

export interface CallOptions {
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function unlinkQuiet(p: string): boolean {
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export class HostPipe {
  readonly dir: string;
  private readonly claimTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly staleMs: number;
  private readonly pollMs: number;

  constructor(opts: HostPipeOptions = {}) {
    this.dir = opts.dir ?? (process.env.HUDDLE_PIPE_DIR || path.join(HOME_DIR, 'pipe'));
    this.claimTimeoutMs = opts.claimTimeoutMs ?? 5_000;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    // tool.run may take up to 15 min on the host; allow a little on top so the
    // agent's own timeout reply wins over ours.
    this.maxTimeoutMs = opts.maxTimeoutMs ?? 15 * 60_000 + 30_000;
    this.staleMs = opts.staleMs ?? 10_000;
    this.pollMs = opts.pollMs ?? 75;
  }

  // The agent's heartbeat. Missing, unreadable or older than staleMs = offline.
  // A timestamp in the future (host clock ahead of the container's) counts as
  // fresh: clocks between a host and a Docker VM drift, and refusing then would
  // make the pipe flap for no reason.
  status(): HostPipeStatus {
    let hb: any;
    try {
      hb = JSON.parse(fs.readFileSync(path.join(this.dir, 'host.json'), 'utf8'));
    } catch {
      return { online: false };
    }
    if (!hb || typeof hb !== 'object') return { online: false };
    const updatedAt = typeof hb.updatedAt === 'string' ? hb.updatedAt : undefined;
    const t = updatedAt ? Date.parse(updatedAt) : NaN;
    const online = Number.isFinite(t) && Date.now() - t <= this.staleMs;
    return {
      online,
      version: typeof hb.version === 'string' ? hb.version : undefined,
      platform: typeof hb.platform === 'string' ? hb.platform : undefined,
      tools: Array.isArray(hb.tools) ? hb.tools.filter((x: unknown): x is string => typeof x === 'string') : undefined,
      updatedAt,
    };
  }

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    // A dead heartbeat already says nobody is listening; failing now spares
    // every caller the 5 s claim wait (and the portal a 5 s spinner per request).
    if (!this.status().online) throw new HostPipeError('host_pipe_offline', 'host agent is not running (huddle pipe status)');

    const id = crypto.randomBytes(16).toString('hex');
    const inFile = path.join(this.dir, `${id}.in`);
    const tmpFile = `${inFile}.tmp`;
    const outFile = path.join(this.dir, `${id}.out`);
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? this.defaultTimeoutMs, 1), this.maxTimeoutMs);

    // No mkdir: the agent owns the folder. Creating it from the container
    // could leave a root-owned directory in the user's ~/.huddle.
    try {
      fs.writeFileSync(tmpFile, JSON.stringify({ v: 1, op, args }), 'utf8');
      fs.renameSync(tmpFile, inFile);
    } catch (err) {
      unlinkQuiet(tmpFile);
      throw new HostPipeError('host_pipe_offline', `cannot write to host pipe: ${(err as Error).message}`);
    }

    // Phase 1: wait for the agent to claim (or already answer) the request.
    const claimDeadline = Date.now() + this.claimTimeoutMs;
    while (exists(inFile) && !exists(outFile)) {
      if (Date.now() >= claimDeadline) {
        // Only offline if WE removed it; if the unlink loses the race the agent
        // claimed it just now and we carry on waiting for the reply.
        if (unlinkQuiet(inFile)) throw new HostPipeError('host_pipe_offline', 'host agent did not pick up the request');
        break;
      }
      await sleep(this.pollMs);
    }

    // Phase 2: claimed — wait for the reply.
    const deadline = Date.now() + timeoutMs;
    while (!exists(outFile)) {
      if (Date.now() >= deadline) {
        unlinkQuiet(inFile);
        throw new HostPipeError('host_pipe_timeout', `host agent did not answer '${op}' within ${timeoutMs} ms`);
      }
      await sleep(this.pollMs);
    }

    let reply: any;
    try {
      reply = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (err) {
      throw new HostPipeError('internal', `unreadable host pipe reply: ${(err as Error).message}`);
    } finally {
      unlinkQuiet(outFile);
    }
    if (reply && reply.ok === true) return reply.result as T;
    const e = reply?.error ?? {};
    throw new HostPipeError(
      typeof e.code === 'string' ? e.code : 'internal',
      typeof e.message === 'string' ? e.message : 'host pipe request failed'
    );
  }
}

export const hostPipe = new HostPipe();
