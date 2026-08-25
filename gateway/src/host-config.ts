// Access to the host CLI config (`~/.huddle/config.json`), which the CLI binds
// into the gateway (read-write) at /huddle-home (#69). This makes the CLI config
// the single source of truth for the team-managed settings: the portal reads and
// writes them here (not the SQLite DB), so an operator can also review them in
// version control or hand-edit the file.
//
// What lives here:
//  - the team-managed folders (#69): `huddle init`/`restart` reads the same file
//    to mount those folders into the gateway. The gateway itself never needs to
//    resolve the host paths — it reads the folders at the fixed mount points the
//    CLI binds them to (see firewall-groups.ts / extensions).
//  - the resource-limit defaults and the folder mappings (#98). These need no
//    remount: the gateway reads them out of this file whenever it creates a
//    devcontainer, so an edit applies to the next container immediately.
import fs from 'fs';
import path from 'path';

const HOME_DIR = process.env.HUDDLE_HOME_DIR || '/huddle-home';
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

function acquireLock(): number | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return fs.openSync(LOCK_FILE, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null; // dir gone/read-only
      try {
        // Break a lock left behind by a writer that was killed mid-update,
        // otherwise one crash makes the config permanently unwritable.
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK_FILE);
      } catch { /* another process got there first — just retry */ }
      if (Date.now() >= deadline) return null;
      sleepSync(25);
    }
  }
}

function releaseLock(fd: number): void {
  try { fs.closeSync(fd); } catch { /* already closed */ }
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

// Unique per write: two writers sharing one `.tmp` name would truncate each
// other's half-written file and rename the wreckage over the real config.
let tmpSeq = 0;

// Merge-write a patch, preserving everything else in the file (operatorToken,
// channel, …). A key set to `undefined` is dropped from the file rather than
// written as null. Returns false (not mounted, or write failed) so the caller can
// report the outcome — the API endpoints surface `persisted` to the operator, so
// no separate log line is needed here.
export function updateHostConfig(patch: Partial<HostConfig>): boolean {
  if (!hostConfigAvailable()) {
    return false; // config not mounted; run `huddle restart` from the host
  }
  const lock = acquireLock();
  if (lock === null) return false; // another writer holds it; caller sees persisted=false
  const tmp = `${CONFIG_FILE}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    // Read INSIDE the lock: a snapshot taken before it could already be stale.
    const next = { ...readHostConfig(), ...patch };
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
    releaseLock(lock);
  }
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

export function listFolderMappings(): HostFolderMapping[] {
  const raw = readHostConfig().folderMappings;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m, i) => coerceMapping(m, i + 1))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

export function getFolderMapping(id: number): HostFolderMapping | undefined {
  return listFolderMappings().find(m => m.id === id);
}

function writeFolderMappings(mappings: HostFolderMapping[]): boolean {
  // Always write the key, even when empty: its presence marks the config file as
  // the owner of the mappings, which is what stops the legacy SQLite rows from
  // being migrated back in (see settings-migration.ts).
  return updateHostConfig({ folderMappings: mappings });
}

// Returns the new id, or null when the config file could not be written.
export function createFolderMapping(m: Omit<HostFolderMapping, 'id'>): number | null {
  const existing = listFolderMappings();
  const id = existing.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  return writeFolderMappings([...existing, { ...m, id }]) ? id : null;
}

export function updateFolderMapping(id: number, patch: Partial<Omit<HostFolderMapping, 'id'>>): boolean {
  const existing = listFolderMappings();
  if (!existing.some(m => m.id === id)) return false;
  return writeFolderMappings(existing.map(m => (m.id === id ? { ...m, ...patch } : m)));
}

export function deleteFolderMapping(id: number): boolean {
  const existing = listFolderMappings();
  const next = existing.filter(m => m.id !== id);
  if (next.length === existing.length) return true; // already gone
  return writeFolderMappings(next);
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
