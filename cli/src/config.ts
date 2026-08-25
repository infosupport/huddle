import fs from 'fs';
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

function acquireLock(): number | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return fs.openSync(LOCK_PATH, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        // Break a lock left behind by a writer that was killed mid-update.
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK_PATH);
      } catch { /* another process got there first — just retry */ }
      if (Date.now() >= deadline) return null;
      sleepSync(25);
    }
  }
}

function releaseLock(fd: number): void {
  try { fs.closeSync(fd); } catch { /* already closed */ }
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
  const lock = acquireLock();
  if (lock === null) {
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
    releaseLock(lock);
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
