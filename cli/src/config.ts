import fs from 'fs';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';

/**
 * Local Huddle configuration in ~/.huddle/config.json. Among other things we
 * remember which experiment is active here, so every subsequent `huddle init`
 * keeps running on the same channel until the user explicitly resets.
 */
export interface HuddleConfig {
  channel?: 'stable' | 'experiment';
  experiment?: number;
  // Operator-token voor de control-plane-auth. Door `huddle init` gegenereerd en
  // hier bewaard zodat volgende CLI-commando's zich als operator kunnen
  // authenticeren (Authorization: Bearer). Env HUDDLE_OPERATOR_TOKEN wint.
  operatorToken?: string;
  // Team-managed folders (#69). Persisted here (the single source of truth) so
  // the CLI can bind them into the gateway on start/restart (the gateway only
  // sees folders the CLI mounts). The portal edits these via the mounted
  // ~/.huddle/config.json; changes apply on the next `huddle restart`.
  firewallRulesFolder?: string;
  extensionsFolder?: string;
  // Team-managed devcontainer defaults (#98). The gateway reads these straight
  // from this file when it creates a container, so an edit applies to the next
  // container without a restart. The CLI only needs to preserve them on write.
  defaultMemory?: string;
  defaultCpus?: string;
  folderMappings?: FolderMapping[];
}

/** A folder or volume that Huddle mounts into every new devcontainer (#98). */
export interface FolderMapping {
  id: number;
  name: string;
  hostPath: string;
  volumeName: string;
  containerPath: string;
  readOnly: boolean;
  enabled: boolean;
  sortOrder: number;
}

export const CONFIG_DIR = path.join(os.homedir(), '.huddle');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function configPath(): string {
  return CONFIG_PATH;
}

export function readConfig(): HuddleConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as HuddleConfig;
  } catch {
    return {};
  }
}

// ── Cross-process locking ─────────────────────────────────────────────────────
//
// The gateway edits this same file from inside its container (the portal writes
// the folder mappings and resource defaults there, see gateway/src/host-config.ts)
// while the CLI edits it from the host. Both do a read-modify-write of the whole
// document, so without a lock whoever writes last silently reverts the other's
// change. Same protocol on both sides: exclusive create of a sibling lock file,
// which works across the bind mount that joins the two.
const LOCK_PATH = `${CONFIG_PATH}.lock`;
const LOCK_WAIT_MS = 5000; // the gateway holds it for microseconds; this is pure headroom
const LOCK_STALE_MS = 10_000; // older than this means the holder died mid-write

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The lock file carries the identity of its holder, not just its existence. Age
// alone is not enough to decide it may be removed: a writer that pauses past
// LOCK_STALE_MS gets its lock broken and taken over, and would then delete the
// *new* holder's lock on the way out — letting a third writer in alongside the
// second, which is exactly the clobber the lock exists to prevent. A pid would
// not do as identity: the gateway runs in a container and this CLI on the host,
// sharing the file over a bind mount, so their pid spaces are unrelated.
function lockToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

function readLockToken(): string | null {
  try {
    return fs.readFileSync(LOCK_PATH, 'utf8');
  } catch {
    return null; // gone between the stat and the read
  }
}

// Remove a lock left behind by a writer that was killed mid-update, but only that
// exact lock: the token and mtime are re-read right before the unlink, so a lock
// another contender has meanwhile broken and taken over is left in place.
function breakStaleLock(): void {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(LOCK_PATH).mtimeMs;
  } catch {
    return; // already gone
  }
  if (Date.now() - mtimeMs <= LOCK_STALE_MS) return;
  const token = readLockToken();
  if (token === null) return;
  try {
    if (readLockToken() !== token) return;
    if (fs.statSync(LOCK_PATH).mtimeMs !== mtimeMs) return;
    fs.unlinkSync(LOCK_PATH);
  } catch { /* another process got there first — just retry */ }
}

// Returns the token identifying this holder, to be handed back to releaseLock.
function acquireLock(): string | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const token = lockToken();
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      breakStaleLock();
      if (Date.now() >= deadline) return null;
      sleepSync(25);
    }
  }
}

function releaseLock(token: string): void {
  // Never unlink a lock this writer no longer owns: if it was broken as stale and
  // taken over, the file belongs to the writer that is running right now.
  if (readLockToken() !== token) return;
  try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
}

let tmpSeq = 0;

/**
 * The only writer. Merges a patch into the config file, re-reading it inside the
 * lock so a concurrent gateway write is preserved instead of reverted; a key set
 * to `undefined` is removed from the file. There is deliberately no
 * write-the-whole-document variant: every such write was a read-modify-write of
 * a snapshot that could already be stale.
 *
 * Throws when the lock cannot be taken. Writing anyway would reintroduce exactly
 * the clobber the lock exists to prevent — the gateway would have the config open
 * for a read-modify-write of its own, and one of the two edits would vanish. A
 * failed command the operator can retry is the better outcome; the callers below
 * (`huddle init`, `huddle firewall …`, `huddle experiment …`) all abort cleanly
 * because nothing has been written yet at that point.
 *
 * The temp file name is unique per write — a shared `.tmp` lets two writers
 * truncate each other's half-written file and rename the wreckage over the real
 * config.
 */
export function updateConfig(patch: Partial<HuddleConfig>): HuddleConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const token = acquireLock();
  if (token === null) {
    throw new Error(
      `Could not lock ${CONFIG_PATH} within ${LOCK_WAIT_MS}ms — another Huddle process ` +
        `is writing it. Nothing was changed; retry the command. If no other process is ` +
        `running, remove the stale lock: rm ${LOCK_PATH}`,
    );
  }
  const tmp = `${CONFIG_PATH}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    const next = { ...readConfig(), ...patch } as Record<string, unknown>;
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) delete next[k];
    }
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, CONFIG_PATH);
    return next as HuddleConfig;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  } finally {
    releaseLock(token);
  }
}

/** Operator-token voor API-auth: env wint, anders uit de config. */
export function operatorToken(): string | undefined {
  const env = process.env.HUDDLE_OPERATOR_TOKEN?.trim();
  if (env) return env;
  const t = readConfig().operatorToken;
  return t && t.trim() ? t.trim() : undefined;
}

/** Active experiment number, or undefined when running on stable. */
export function activeExperiment(): number | undefined {
  const cfg = readConfig();
  if (cfg.channel === 'experiment' && Number.isInteger(cfg.experiment) && (cfg.experiment as number) > 0) {
    return cfg.experiment;
  }
  return undefined;
}

/** Docker image tag that belongs to the active channel. */
export function imageTag(): string {
  const experiment = activeExperiment();
  return experiment !== undefined ? `experiment-${experiment}` : 'latest';
}
