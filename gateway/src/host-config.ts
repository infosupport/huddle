// Access to the host CLI config (`~/.huddle/config.json`), which the CLI binds
// into the gateway (read-write) at /huddle-home (#69). This makes the CLI config
// the single source of truth for the team-managed settings: the portal reads and
// writes them here (not the SQLite DB), so an operator can also review them in
// version control or hand-edit the file.
//
// What lives here:
//  - the team-managed folders (#69). These used to be bind-mounted into the
//    gateway at fixed paths; Huddle Node runs on the host and reads them where
//    they are, straight out of this file, so an edit applies to the next reload
//    (see firewall-rules-folder.ts / extensions/loader.ts).
//  - the resource-limit defaults and the folder mappings (#98). These need no
//    remount: the gateway reads them out of this file whenever it creates a
//    devcontainer, so an edit applies to the next container immediately.
import fs from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { runtimeEnv } from './runtime-env';

const HOME_DIR = runtimeEnv.homeDir;
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');

// A folder mapping as stored in config.json: camelCase and real booleans, so the
// file stays readable for the humans who edit it. `id` is a stable handle for the
// portal's edit/delete calls, not a database key.
export interface HostFolderMapping {
  id: number;
  name: string;
  hostPath: string;
  volumeName: string;
  containerPath: string;
  readOnly: boolean;
  enabled: boolean;
  sortOrder: number;
}

// The shape the HTTP API speaks (unchanged from when these rows lived in SQLite,
// so the portal keeps working): snake_case with 0/1 for the flags.
export interface FolderMapping {
  id: number;
  name: string;
  host_path: string;
  volume_name: string;
  container_path: string;
  read_only: number;
  enabled: number;
  sort_order: number;
}

export interface ResourceDefaults {
  defaultMemory: string;
  defaultCpus: string;
}

export interface HostConfig {
  firewallRulesFolder?: string;
  extensionsFolder?: string;
  defaultMemory?: string;
  defaultCpus?: string;
  folderMappings?: HostFolderMapping[];
  [k: string]: unknown;
}

export function hostConfigAvailable(): boolean {
  try { return fs.existsSync(CONFIG_FILE); } catch { return false; }
}

export function readHostConfig(): HostConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as HostConfig;
  } catch {
    return {};
  }
}

// ── Cross-process locking ─────────────────────────────────────────────────────
//
// Two processes edit this one file: the gateway (every portal edit below) and
// the CLI on the host (`huddle init`, `firewall folder set`, `experiment use`),
// and both do a read-modify-write of the whole document. Without a lock the
// slower writer's snapshot is already stale when it lands, so it silently
// reverts the other one's change — an operator loses a folder mapping or a
// resource default with no error anywhere and a stale mount on the next start.
//
// The lock is an exclusive create (`wx`) of a sibling file, which is what makes
// it work across the bind mount that joins the container to the host. The CLI
// takes the same lock in cli/src/config.ts; keep the two in step.
const LOCK_FILE = `${CONFIG_FILE}.lock`;
const LOCK_WAIT_MS = 2000; // bounded: an API request must not hang on a lock
const LOCK_STALE_MS = 10_000; // older than this means the holder died mid-write

// Synchronous sleep. updateHostConfig is sync all the way up to its callers, and
// making it async would ripple through the API layer for a wait that is only
// ever a few milliseconds.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The lock file carries the identity of whoever holds it, not just its existence.
// Age alone is not enough to decide it may be removed: a writer that pauses past
// LOCK_STALE_MS gets its lock broken and taken over, and would then delete the
// *new* holder's lock on the way out — letting a third writer in alongside the
// second, which is the clobber this whole file is trying to prevent. So both
// breaking and releasing check the token first. A pid would not do: the gateway
// runs in a container and the CLI on the host, sharing this file over a bind
// mount, so their pid spaces are unrelated.
function lockToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

function readLockToken(): string | null {
  try {
    return fs.readFileSync(LOCK_FILE, 'utf8');
  } catch {
    return null; // gone between the stat and the read
  }
}

// Remove a lock left behind by a writer that was killed mid-update — otherwise one
// crash makes the config permanently unwritable — but only that exact lock. The
// token and mtime are re-read right before the unlink: if either moved, another
// contender already broke it and this is their live lock, so leave it alone.
function breakStaleLock(): void {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(LOCK_FILE).mtimeMs;
  } catch {
    return; // already gone
  }
  if (Date.now() - mtimeMs <= LOCK_STALE_MS) return;
  const token = readLockToken();
  if (token === null) return;
  try {
    if (readLockToken() !== token) return;
    if (fs.statSync(LOCK_FILE).mtimeMs !== mtimeMs) return;
    fs.unlinkSync(LOCK_FILE);
  } catch { /* another process got there first — just retry */ }
}

// Returns the token identifying this holder, to be handed back to releaseLock.
function acquireLock(): string | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const token = lockToken();
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null; // dir gone/read-only
      breakStaleLock();
      if (Date.now() >= deadline) return null;
      sleepSync(25);
    }
  }
}

function releaseLock(token: string): void {
  // Never unlink a lock this writer no longer owns: if it was broken as stale and
  // taken over, the file now belongs to the writer that is running right now.
  if (readLockToken() !== token) return;
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

// Unique per write: two writers sharing one `.tmp` name would truncate each
// other's half-written file and rename the wreckage over the real config.
let tmpSeq = 0;

// Read-modify-write the config under the lock. `mutate` receives the contents as
// they are on disk *right now* and returns the keys to change, or null to abort
// the write. Anything whose new value is derived from the current contents (the
// folder-mapping CRUD below) must go through here rather than through
// updateHostConfig: reading first and passing the result as a patch would write
// back a snapshot that a concurrent writer has already moved past, silently
// dropping their edit.
export function mutateHostConfig(
  mutate: (current: HostConfig) => Partial<HostConfig> | null,
): boolean {
  if (!hostConfigAvailable()) {
    return false; // config not mounted; run `huddle restart` from the host
  }
  const token = acquireLock();
  if (token === null) return false; // another writer holds it; caller sees persisted=false
  const tmp = `${CONFIG_FILE}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    // Read INSIDE the lock: a snapshot taken before it could already be stale.
    const current = readHostConfig();
    const patch = mutate(current);
    if (patch === null) return false; // mutator decided there is nothing to write
    const next = { ...current, ...patch };
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) delete next[k];
    }
    // Write-then-rename so a crash mid-write cannot leave a truncated config
    // behind — the CLI reads this same file to start Huddle.
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_FILE);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    return false; // write failed; caller sees persisted=false
  } finally {
    releaseLock(token);
  }
}

// Merge-write a patch, preserving everything else in the file (operatorToken,
// channel, …). A key set to `undefined` is dropped from the file rather than
// written as null. Returns false (not mounted, or write failed) so the caller can
// report the outcome — the API endpoints surface `persisted` to the operator, so
// no separate log line is needed here. Only for values that do not depend on what
// is already in the file; use mutateHostConfig when they do.
export function updateHostConfig(patch: Partial<HostConfig>): boolean {
  return mutateHostConfig(() => patch);
}

export function setHostFolder(key: 'firewallRulesFolder' | 'extensionsFolder', value: string): boolean {
  return updateHostConfig({ [key]: value || undefined });
}

// ── Resource limits (#98) ─────────────────────────────────────────────────────

export function getResourceDefaults(): ResourceDefaults {
  const cfg = readHostConfig();
  return {
    defaultMemory: typeof cfg.defaultMemory === 'string' ? cfg.defaultMemory : '',
    defaultCpus: typeof cfg.defaultCpus === 'string' ? cfg.defaultCpus : '',
  };
}

// An empty value means "no explicit default" and is removed from the file, so
// docker.ts falls back to its built-in default.
export function setResourceDefaults(p: Partial<ResourceDefaults>): boolean {
  const patch: Partial<HostConfig> = {};
  if (p.defaultMemory !== undefined) patch.defaultMemory = p.defaultMemory || undefined;
  if (p.defaultCpus !== undefined) patch.defaultCpus = p.defaultCpus || undefined;
  if (Object.keys(patch).length === 0) return true;
  return updateHostConfig(patch);
}

// ── Folder mappings (#98) ─────────────────────────────────────────────────────

// Coerce one raw entry from the file. The file is hand-editable, so every field
// is treated as untrusted: a malformed entry degrades to a harmless default
// rather than reaching the Docker mount spec as `undefined`.
function coerceMapping(raw: unknown, fallbackId: number): HostFolderMapping {
  const m = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    id: typeof m.id === 'number' && Number.isFinite(m.id) ? m.id : fallbackId,
    name: str(m.name),
    hostPath: str(m.hostPath),
    volumeName: str(m.volumeName),
    containerPath: str(m.containerPath),
    readOnly: m.readOnly === true,
    enabled: m.enabled !== false, // absent means enabled
    sortOrder: typeof m.sortOrder === 'number' && Number.isFinite(m.sortOrder) ? m.sortOrder : 0,
  };
}

// Split out from listFolderMappings so the CRUD below can re-derive the mappings
// from the config that mutateHostConfig read inside the lock, instead of from a
// snapshot taken before it.
function mappingsOf(config: HostConfig): HostFolderMapping[] {
  const raw = config.folderMappings;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m, i) => coerceMapping(m, i + 1))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

export function listFolderMappings(): HostFolderMapping[] {
  return mappingsOf(readHostConfig());
}

export function getFolderMapping(id: number): HostFolderMapping | undefined {
  return listFolderMappings().find(m => m.id === id);
}

// Every mutator below writes the whole `folderMappings` key, even when the list
// ends up empty: its presence marks the config file as the owner of the mappings,
// which is what stops the legacy SQLite rows from being migrated back in (see
// settings-migration.ts).

// Returns the new id, or null when the config file could not be written.
export function createFolderMapping(m: Omit<HostFolderMapping, 'id'>): number | null {
  let id = 0;
  const written = mutateHostConfig(current => {
    const existing = mappingsOf(current);
    // Derive the id inside the lock too, or two concurrent creates both pick
    // max+1 and the second silently overwrites the first.
    id = existing.reduce((max, e) => Math.max(max, e.id), 0) + 1;
    return { folderMappings: [...existing, { ...m, id }] };
  });
  return written ? id : null;
}

export function updateFolderMapping(id: number, patch: Partial<Omit<HostFolderMapping, 'id'>>): boolean {
  return mutateHostConfig(current => {
    const existing = mappingsOf(current);
    if (!existing.some(e => e.id === id)) return null; // deleted since the caller listed them
    return { folderMappings: existing.map(e => (e.id === id ? { ...e, ...patch } : e)) };
  });
}

export function deleteFolderMapping(id: number): boolean {
  let alreadyGone = false;
  const written = mutateHostConfig(current => {
    const existing = mappingsOf(current);
    const next = existing.filter(e => e.id !== id);
    if (next.length === existing.length) {
      alreadyGone = true;
      return null; // nothing to write; deleting a deleted mapping still succeeds
    }
    return { folderMappings: next };
  });
  return written || alreadyGone;
}

// ── Wire conversion ───────────────────────────────────────────────────────────

export function toWireMapping(m: HostFolderMapping): FolderMapping {
  return {
    id: m.id,
    name: m.name,
    host_path: m.hostPath,
    volume_name: m.volumeName,
    container_path: m.containerPath,
    read_only: m.readOnly ? 1 : 0,
    enabled: m.enabled ? 1 : 0,
    sort_order: m.sortOrder,
  };
}

// The wire fields a client may set, mapped to their config-file counterpart.
// Doubles as the update allowlist: anything outside it is rejected fail-closed
// (originally the #9 SQL-injection defense — the keys used to be interpolated
// into an UPDATE statement. They no longer touch SQL, but a config file is not a
// dumping ground for arbitrary client keys either, and the portal still relies on
// the 400 for a typo'd field).
const WIRE_FIELDS: Record<string, keyof Omit<HostFolderMapping, 'id'>> = {
  name: 'name',
  host_path: 'hostPath',
  volume_name: 'volumeName',
  container_path: 'containerPath',
  read_only: 'readOnly',
  enabled: 'enabled',
  sort_order: 'sortOrder',
};

// Returns the recognised wire keys; throws on any unknown key. Pure, so the
// fail-closed behaviour stays testable in isolation.
export function validateFolderMappingKeys(m: object): string[] {
  const keys = Object.keys(m);
  const unknown = keys.filter(k => !(k in WIRE_FIELDS));
  if (unknown.length > 0) {
    throw new Error(`unknown folder-mapping field(s): ${unknown.join(', ')}`);
  }
  return keys;
}

// Convert a (partial) wire object into a config-file patch. Validates first, so
// an unknown key throws instead of being silently dropped.
export function fromWirePatch(w: object): Partial<Omit<HostFolderMapping, 'id'>> {
  const keys = validateFolderMappingKeys(w);
  const src = w as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of keys) {
    const target = WIRE_FIELDS[k];
    const v = src[k];
    if (target === 'readOnly' || target === 'enabled') patch[target] = v === 1 || v === true;
    else if (target === 'sortOrder') patch[target] = typeof v === 'number' ? v : 0;
    else patch[target] = typeof v === 'string' ? v : '';
  }
  return patch as Partial<Omit<HostFolderMapping, 'id'>>;
}
