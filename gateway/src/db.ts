import type { AuditEntry, AuditResponse } from './db-types';
import { HuddleDatabase } from './sqlite';
import { runtimeEnv } from './runtime-env';

const DB_PATH = runtimeEnv.dbPath;

export const db = new HuddleDatabase(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      container_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('requested','allow','deny')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
      request_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS docker_grants (
      container_id TEXT PRIMARY KEY,
      until INTEGER NOT NULL
    );
    -- Ephemeral sudo grants: per container we remember ONLY when the admin
    -- access to 'noot' expires (until, unix seconds). Deliberately NO password
    -- (not even a hash) — the fresh password is shown to the UI exactly once and
    -- then kept nowhere (finding #10). The sweeper uses this row to lock the
    -- account again on expiry.
    CREATE TABLE IF NOT EXISTS sudo_grants (
      container_id TEXT PRIMARY KEY,
      until INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS docker_action_policies (
      container_id TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      PRIMARY KEY (container_id, action)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL DEFAULT (unixepoch()),
      container_id TEXT,
      domain TEXT NOT NULL,
      port INTEGER,
      action TEXT NOT NULL,
      rule_id INTEGER,
      method TEXT,
      path TEXT,
      req_headers TEXT,
      req_body TEXT,
      res_status INTEGER,
      res_headers TEXT,
      res_body TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_container ON audit_log(container_id);
    CREATE TABLE IF NOT EXISTS container_credentials (
      container_id TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS containers (
      name TEXT PRIMARY KEY,
      airlocked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ext_kv (
      ext_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (ext_id, key)
    );
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      image TEXT NOT NULL,
      port INTEGER NOT NULL,
      transport TEXT NOT NULL DEFAULT 'sse',
      manifest_json TEXT NOT NULL,
      container_id TEXT,
      status TEXT NOT NULL DEFAULT 'stopped',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS approved_host_ports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id TEXT NOT NULL,
      host_port INTEGER NOT NULL,
      container_port INTEGER NOT NULL DEFAULT 0,
      protocol TEXT NOT NULL DEFAULT 'tcp',
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(container_id, host_port, protocol)
    );
    -- Firewall groups (#69): a named, reusable bundle of firewall rules for a
    -- product/service (OpenAI, GitHub, ...). Rules point at a group via
    -- rules.group_id. The shared flag marks a group meant to travel between
    -- installs; source records whether it was created in the UI (manual) or
    -- loaded from the team-managed rules folder (startup-folder).
    CREATE TABLE IF NOT EXISTS firewall_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      shared INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_firewall_groups_name
      ON firewall_groups (name COLLATE NOCASE);
    -- Per-sandbox identity (docs/ADR-sbx-identity.md). A sandbox cannot be
    -- recognised by its source address the way a devcontainer is, so Huddle Node
    -- mints a secret per box and puts it in the upstream-proxy URL sbx bakes in
    -- at create. Node keeps the secret because it writes that URL; the control
    -- feed hands the gateway only the name and the hash, which is all it needs
    -- to recognise an identity without possessing one.
    CREATE TABLE IF NOT EXISTS sandbox_identity (
      name TEXT PRIMARY KEY,
      secret TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    -- Container names \`huddle migrate --docker-socket\` asked Node to serve a
    -- filtered Docker socket for, ahead of the container ever existing (blocker
    -- 15, docs/ADR-huddle-node-split.md). Node did not create these
    -- containers, so it has no other way to learn their names before they
    -- start — unlike a Huddle-created devcontainer, which the IDE label in
    -- containerSnapshot() already covers. buildContainerFeed() unions this
    -- table into ContainerFeed.devcontainers so the gateway's socket relay
    -- (../socket-relay.ts) creates the socket regardless of whether the
    -- container is running yet, which it has to be for the compose bind mount
    -- to see a live socket instead of an empty directory.
    CREATE TABLE IF NOT EXISTS socket_registrations (
      name TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      revision TEXT NOT NULL DEFAULT '',
      ready_at INTEGER
    );
  `);

  // The folder index (#69) is gone: the portal browses the host live now that
  // Huddle Node runs there, so a snapshot of folder names is at best redundant
  // and at worst wrong. Drop it rather than leave a table nothing reads —
  // machine-local scan output, so there is nothing here worth migrating.
  db.exec('DROP TABLE IF EXISTS indexed_folders');

  const cols = db.prepare("PRAGMA table_info(rules)").all() as {name:string}[];
  if (!cols.some(c => c.name === 'expires_at')) {
    db.exec('ALTER TABLE rules ADD COLUMN expires_at INTEGER');
  }
  if (!cols.some(c => c.name === 'path_pattern')) {
    db.exec('ALTER TABLE rules ADD COLUMN path_pattern TEXT');
  }
  // The first implementation of socket registrations only stored a name.
  // Upgrade it in place if a development build created that short-lived schema
  // before readiness acknowledgements were added.
  const socketCols = db.prepare("PRAGMA table_info(socket_registrations)").all() as {name:string}[];
  if (!socketCols.some(c => c.name === 'revision')) {
    db.exec("ALTER TABLE socket_registrations ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
  }
  if (!socketCols.some(c => c.name === 'ready_at')) {
    db.exec('ALTER TABLE socket_registrations ADD COLUMN ready_at INTEGER');
  }
  // path_mode marks a host-only rule as a "path allowlist": the bare domain is
  // then closed (status deny), but unknown subpaths are raised as 'requested' so
  // the operator can allow them one by one.
  if (!cols.some(c => c.name === 'path_mode')) {
    db.exec('ALTER TABLE rules ADD COLUMN path_mode INTEGER NOT NULL DEFAULT 0');
  }
  // last_path stores the most recently seen full path that triggered a (grouped)
  // requested path rule, as a concrete example for the operator.
  if (!cols.some(c => c.name === 'last_path')) {
    db.exec('ALTER TABLE rules ADD COLUMN last_path TEXT');
  }
  // Firewall groups (#69): a rule may belong to one group (NULL = ungrouped).
  // added_by records the operator identity that created it (shown as "you" in
  // the UI); source is 'manual' or 'startup-folder' (loaded from the team folder).
  if (!cols.some(c => c.name === 'group_id')) {
    db.exec('ALTER TABLE rules ADD COLUMN group_id INTEGER');
  }
  if (!cols.some(c => c.name === 'added_by')) {
    db.exec('ALTER TABLE rules ADD COLUMN added_by TEXT');
  }
  if (!cols.some(c => c.name === 'source')) {
    db.exec("ALTER TABLE rules ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_rules_group ON rules(group_id)');

  // Drop the legacy unique indexes FIRST. The lowercase migration below rewrites
  // `GIST.github.com` -> `gist.github.com`, which would collide with an existing
  // `gist.github.com` row while a stale (possibly case-sensitive) unique index is
  // still in place — aborting initDb() and preventing the upgraded gateway from
  // booting. Removing the constraints up front lets the UPDATE and the dedup run
  // freely; the case-insensitive index is (re)created afterwards.
  db.exec('DROP INDEX IF EXISTS idx_rules_domain_container');
  db.exec('DROP INDEX IF EXISTS idx_rules_domain_container_path');

  // Collapse case variants BEFORE lowercasing so the survivors are unique per
  // (domain, container, path) even case-insensitively. NOCASE in the GROUP BY so
  // `GIST.github.com` and `gist.github.com` coincide and only MAX(id) is kept;
  // this also prevents the lowercase UPDATE below from creating duplicates.
  db.exec(`
    DELETE FROM rules
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM rules
      GROUP BY domain COLLATE NOCASE, COALESCE(container_id, ''), COALESCE(path_pattern, '')
    )
  `);

  // Domains are now stored canonically (lowercase) so the exact lookup and the
  // wildcard match operate on the same form (finding #3). With the old indexes
  // gone and case variants already deduped, this rewrite can no longer collide.
  db.exec('UPDATE rules SET domain = lower(domain) WHERE domain <> lower(domain)');

  // Uniqueness now applies to (domain, container, path) case-insensitively:
  // multiple path rules per domain must be able to coexist.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_domain_container_path
       ON rules (domain COLLATE NOCASE, COALESCE(container_id, ''), COALESCE(path_pattern, ''))`
  );

  // Seed the global allow rule for huddle's own domain so the sudo-audit
  // forwarder (and any future self-traffic) doesn't auto-create a 'requested'
  // entry every time a fresh DB is used. Path-level enforcement still lives in
  // proxy.ts / api.ts — this only authorises the domain itself.
  db.prepare(
    `INSERT OR IGNORE INTO rules (domain, container_id, status) VALUES ('huddle', NULL, 'allow')`
  ).run();

  // Keep Huddle's own self-traffic rule in a dedicated "huddle" group so it is
  // clearly separated from user/team rules in the portal. Idempotent: the group
  // is created once (unique name) and the seeded rule is filed under it.
  db.prepare(
    `INSERT OR IGNORE INTO firewall_groups (name, description, shared, source)
     VALUES ('huddle', 'Huddle self-traffic (gateway and portal). Managed by Huddle.', 0, 'manual')`
  ).run();
  const huddleGroup = db
    .prepare(`SELECT id FROM firewall_groups WHERE name = 'huddle' COLLATE NOCASE`)
    .get() as { id: number } | undefined;
  if (huddleGroup) {
    db.prepare(
      `UPDATE rules SET group_id = ? WHERE domain = 'huddle' AND container_id IS NULL AND group_id IS NULL`
    ).run(huddleGroup.id);
  }

  db.exec("DELETE FROM audit_log WHERE ts < unixepoch() - 604800");

  const count = (db.prepare("SELECT COUNT(*) as n FROM audit_log").get() as { n: number }).n;
  console.log(`[audit] ${count} entries in audit_log`);

  db.prepare(
    `INSERT INTO audit_log (container_id, domain, port, action, rule_id, method, path, req_headers, req_body, res_status, res_headers, res_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(null, 'gateway', null, 'system:start', null, null, null, null, null, null, null, null);
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// ── Container airlock ────────────────────────────────────────────────────────

export function getAirlocked(name: string): boolean {
  const row = db.prepare(`SELECT airlocked FROM containers WHERE name = ?`)
    .get(name) as { airlocked: number } | undefined;
  return row?.airlocked === 1;
}

export function setAirlocked(name: string, value: boolean): void {
  db.prepare(
    `INSERT INTO containers (name, airlocked) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET airlocked = excluded.airlocked`
  ).run(name, value ? 1 : 0);
}

// ── Docker access grants ─────────────────────────────────────────────────────

export function setGrant(containerId: string, until: number): void {
  db.prepare(`INSERT INTO docker_grants (container_id, until) VALUES (?, ?)
              ON CONFLICT(container_id) DO UPDATE SET until = excluded.until`)
    .run(containerId, until);
}

export function getGrant(containerId: string): { until: number } | null {
  return db.prepare(`SELECT until FROM docker_grants WHERE container_id = ?`)
    .get(containerId) as { until: number } | null;
}

export function deleteGrant(containerId: string): void {
  db.prepare(`DELETE FROM docker_grants WHERE container_id = ?`).run(containerId);
}

export function getAllGrants(): Record<string, { until: number }> {
  const rows = db.prepare(`SELECT container_id, until FROM docker_grants`).all() as
    { container_id: string; until: number }[];
  return Object.fromEntries(rows.map((r) => [r.container_id, { until: r.until }]));
}

// ── Ephemeral sudo grants ────────────────────────────────────────────────────
// Mirrors the docker_grants helpers, but separate from them: a sudo grant
// governs the temporary admin password on the 'noot' user inside the container,
// not the socket proxy. No (plaintext or hashed) password is ever stored.

export function setSudoGrant(containerId: string, until: number): void {
  db.prepare(`INSERT INTO sudo_grants (container_id, until) VALUES (?, ?)
              ON CONFLICT(container_id) DO UPDATE SET until = excluded.until`)
    .run(containerId, until);
}

export function getSudoGrant(containerId: string): { until: number } | undefined {
  return db.prepare(`SELECT until FROM sudo_grants WHERE container_id = ?`)
    .get(containerId) as { until: number } | undefined;
}

export function deleteSudoGrant(containerId: string): void {
  db.prepare(`DELETE FROM sudo_grants WHERE container_id = ?`).run(containerId);
}

export function getAllSudoGrants(): Record<string, { until: number }> {
  const rows = db.prepare(`SELECT container_id, until FROM sudo_grants`).all() as
    { container_id: string; until: number }[];
  return Object.fromEntries(rows.map((r) => [r.container_id, { until: r.until }]));
}

// All grants whose until is on or before `nowSec` — the sweeper locks these
// containers and cleans up the row.
export function getExpiredSudoGrants(nowSec: number): string[] {
  const rows = db.prepare(`SELECT container_id FROM sudo_grants WHERE until <= ?`)
    .all(nowSec) as { container_id: string }[];
  return rows.map((r) => r.container_id);
}

// ── Docker action policies (fine-grained permissions per action) ─────────────
// Only explicit overrides are stored in the db; if a row is missing, the default
// from the action catalog (docker-actions.ts) applies.

export function getActionPolicy(containerId: string, action: string): boolean | null {
  const row = db.prepare(
    `SELECT enabled FROM docker_action_policies WHERE container_id = ? AND action = ?`
  ).get(containerId, action) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : null;
}

export function setActionPolicy(containerId: string, action: string, enabled: boolean): void {
  db.prepare(
    `INSERT INTO docker_action_policies (container_id, action, enabled) VALUES (?, ?, ?)
     ON CONFLICT(container_id, action) DO UPDATE SET enabled = excluded.enabled`
  ).run(containerId, action, enabled ? 1 : 0);
}

export function getActionPolicies(containerId: string): Record<string, boolean> {
  const rows = db.prepare(
    `SELECT action, enabled FROM docker_action_policies WHERE container_id = ?`
  ).all(containerId) as { action: string; enabled: number }[];
  return Object.fromEntries(rows.map(r => [r.action, r.enabled === 1]));
}

// ── Audit logging ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _insertAudit: any = null;
function insertAudit() {
  if (!_insertAudit) _insertAudit = db.prepare(
    `INSERT INTO audit_log (container_id, domain, port, action, rule_id, method, path, req_headers, req_body, res_status, res_headers, res_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return _insertAudit;
}


// The audit row shapes live in ./db-types so the gateway can name them without
// importing a native database binding. Re-exported here: every caller so far
// imports them from './db', and that is still where they are written.
export type { AuditEntry, AuditResponse } from './db-types';

// Insert a single audit row. Returns the new row id (or null on error) so an
// in-flight request can be logged immediately and later completed with the
// response via updateAuditResponse.
export function logAudit(entry: AuditEntry): number | null {
  try {
    const info = insertAudit().run(
      entry.containerId ?? null,
      entry.domain,
      entry.port ?? null,
      entry.action,
      entry.ruleId ?? null,
      entry.method ?? null,
      entry.path ?? null,
      entry.reqHeaders ?? null,
      entry.reqBody ?? null,
      entry.resStatus ?? null,
      entry.resHeaders ?? null,
      entry.resBody ?? null,
    );
    return Number(info.lastInsertRowid);
  } catch (err) { console.error('[audit] log failed:', err); return null; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _updateAudit: any = null;

// Fill in the response fields (and the now fully buffered req_body) on a
// previously inserted in-flight audit row.
export function updateAuditResponse(id: number, r: AuditResponse): void {
  try {
    if (!_updateAudit) _updateAudit = db.prepare(
      `UPDATE audit_log SET req_body = ?, res_status = ?, res_headers = ?, res_body = ? WHERE id = ?`
    );
    _updateAudit.run(
      r.reqBody ?? null,
      r.resStatus ?? null,
      r.resHeaders ?? null,
      r.resBody ?? null,
      id,
    );
  } catch (err) { console.error('[audit] update failed:', err); }
}

// ── Container credentials ────────────────────────────────────────────────────

export function saveCredentials(containerName: string, password: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO container_credentials (container_id, password) VALUES (?, ?)`
  ).run(containerName, password);
}

export function getCredentials(containerName: string): { password: string; created_at: number } | undefined {
  return db.prepare(
    `SELECT password, created_at FROM container_credentials WHERE container_id = ?`
  ).get(containerName) as { password: string; created_at: number } | undefined;
}

// ── Extension key-value store ────────────────────────────────────────────────

export function getExtValue(extId: string, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM ext_kv WHERE ext_id = ? AND key = ?`)
    .get(extId, key) as { value: string } | undefined;
  return row?.value;
}

export function setExtValue(extId: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO ext_kv (ext_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(ext_id, key) DO UPDATE SET value = excluded.value`
  ).run(extId, key, value);
}

// ── MCP Servers ──────────────────────────────────────────────────────────────

export interface McpServerRow {
  id: string;
  name: string;
  version: string;
  image: string;
  port: number;
  transport: string;
  manifest_json: string;
  container_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export function getMcpServer(id: string): McpServerRow | undefined {
  return db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`).get(id) as McpServerRow | undefined;
}

export function listMcpServers(): McpServerRow[] {
  return db.prepare(`SELECT * FROM mcp_servers ORDER BY created_at ASC`).all() as McpServerRow[];
}

export function upsertMcpServer(row: McpServerRow): void {
  db.prepare(
    `INSERT INTO mcp_servers (id, name, version, image, port, transport, manifest_json, container_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       version = excluded.version,
       image = excluded.image,
       port = excluded.port,
       transport = excluded.transport,
       manifest_json = excluded.manifest_json,
       container_id = excluded.container_id,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run(row.id, row.name, row.version, row.image, row.port, row.transport, row.manifest_json, row.container_id, row.status, row.created_at, row.updated_at);
}

export function deleteMcpServer(id: string): void {
  db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
}

export function updateMcpServerStatus(id: string, status: string, containerId: string | null): void {
  db.prepare(
    `UPDATE mcp_servers SET status = ?, container_id = ?, updated_at = unixepoch() WHERE id = ?`
  ).run(status, containerId, id);
}

// ── MCP key-value store (reuses ext_kv with prefix 'mcp-<id>') ──────────────

export function getMcpValue(id: string, key: string): string | undefined {
  return getExtValue('mcp-' + id, key);
}

export function setMcpValue(id: string, key: string, value: string): void {
  setExtValue('mcp-' + id, key, value);
}

export function deleteMcpValues(id: string): void {
  db.prepare(`DELETE FROM ext_kv WHERE ext_id = ?`).run('mcp-' + id);
}

// ── Legacy folder mappings (pre-#98) ─────────────────────────────────────────

// Folder mappings now live in the CLI config file (~/.huddle/config.json) so the
// team can review and hand-edit them — see host-config.ts. The table is no longer
// created for fresh installs; this reader exists only so an install that predates
// #98 can migrate its rows once (settings-migration.ts).
export interface LegacyFolderMappingRow {
  id: number;
  name: string;
  host_path: string;
  volume_name: string;
  container_path: string;
  read_only: number;
  enabled: number;
  sort_order: number;
}

export function readLegacyFolderMappings(): LegacyFolderMappingRow[] {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'folder_mappings'"
  ).get();
  if (!table) return [];
  // Columns listed explicitly: the row shape below is what the migration maps,
  // and a `SELECT *` would silently hand it whatever a future column adds.
  return db.prepare(
    `SELECT id, name, host_path, volume_name, container_path, read_only, enabled, sort_order
       FROM folder_mappings ORDER BY sort_order ASC, id ASC`
  ).all() as LegacyFolderMappingRow[];
}

// Validate the update keys of any table against its column allowlist. Pure (no
// DB) so the SQL-injection defense (finding #9) is testable in isolation.
// Returns the allowed keys; throws on any unknown key (fail-closed). Every
// dynamic `UPDATE` in this module funnels its caller-supplied keys through here,
// so the allowlist is the single place that decides what may reach the SQL text.
export function validateUpdateKeys<K extends string>(
  m: object,
  allowed: ReadonlyArray<K>,
  what: string,
): K[] {
  const permitted = allowed as ReadonlyArray<string>;
  const keys = Object.keys(m);
  const unknown = keys.filter(k => !permitted.includes(k));
  if (unknown.length > 0) {
    throw new Error(`unknown ${what} field(s): ${unknown.join(', ')}`);
  }
  return keys.filter((k): k is K => permitted.includes(k));
}

// ── Firewall Groups (#69) ─────────────────────────────────────────────────────

export interface FirewallGroup {
  id: number;
  name: string;
  description: string;
  shared: number;
  source: string; // 'manual' | 'startup-folder'
  created_at: number;
  updated_at: number;
}

export interface FirewallGroupWithCount extends FirewallGroup {
  rule_count: number;
}

export function listGroups(): FirewallGroupWithCount[] {
  return db.prepare(
    `SELECT g.id, g.name, g.description, g.shared, g.source, g.created_at, g.updated_at,
            (SELECT COUNT(*) FROM rules r WHERE r.group_id = g.id) AS rule_count
       FROM firewall_groups g
      ORDER BY g.name COLLATE NOCASE ASC`
  ).all() as FirewallGroupWithCount[];
}

export function getGroup(id: number): FirewallGroup | undefined {
  return db.prepare(
    'SELECT id, name, description, shared, source, created_at, updated_at FROM firewall_groups WHERE id = ?'
  ).get(id) as FirewallGroup | undefined;
}

export function getGroupByName(name: string): FirewallGroup | undefined {
  // Columns listed explicitly (as in getGroup above) so the row shape stays tied
  // to FirewallGroup instead of to whatever the table happens to hold.
  return db.prepare(
    'SELECT id, name, description, shared, source, created_at, updated_at FROM firewall_groups WHERE name = ? COLLATE NOCASE'
  ).get(name) as FirewallGroup | undefined;
}

export function createGroup(g: { name: string; description?: string; shared?: number; source?: string }): number {
  const result = db.prepare(
    `INSERT INTO firewall_groups (name, description, shared, source) VALUES (?, ?, ?, ?)`
  ).run(g.name, g.description ?? '', g.shared ?? 0, g.source ?? 'manual');
  return Number(result.lastInsertRowid);
}

// Column allowlist for dynamic updates — keys never come from request input into
// the SQL text (same SQL-injection defense as folder mappings, finding #9).
const FIREWALL_GROUP_COLUMNS: ReadonlyArray<'name' | 'description' | 'shared' | 'source'> = [
  'name', 'description', 'shared', 'source',
];

export function validateGroupKeys(m: object): Array<'name' | 'description' | 'shared' | 'source'> {
  return validateUpdateKeys(m, FIREWALL_GROUP_COLUMNS, 'group');
}

export function updateGroup(
  id: number,
  m: Partial<Pick<FirewallGroup, 'name' | 'description' | 'shared' | 'source'>>,
): void {
  const keys = validateGroupKeys(m);
  if (keys.length === 0) return;
  const fields = [...keys.map((k) => `${k} = ?`), 'updated_at = unixepoch()'].join(', ');
  const values = [...keys.map((k) => (m as Record<string, unknown>)[k]), id];
  db.prepare(`UPDATE firewall_groups SET ${fields} WHERE id = ?`).run(...values);
}

// Deleting a group ungroups its rules (group_id → NULL); the rules themselves
// are kept so an accidental group delete never silently opens/closes traffic.
export function deleteGroup(id: number): void {
  const tx = db.transaction(() => {
    db.prepare('UPDATE rules SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM firewall_groups WHERE id = ?').run(id);
  });
  tx();
}

// ── Approved Host Ports ───────────────────────────────────────────────────────

export interface ApprovedHostPort {
  id: number;
  container_id: string;
  host_port: number;
  container_port: number;
  protocol: string;
  description: string;
  created_at: number;
}

export function listApprovedHostPorts(containerId: string): ApprovedHostPort[] {
  return db.prepare('SELECT * FROM approved_host_ports WHERE container_id = ? ORDER BY host_port ASC')
    .all(containerId) as ApprovedHostPort[];
}

export function addApprovedHostPort(p: Omit<ApprovedHostPort, 'id' | 'created_at'>): number {
  const result = db.prepare(
    `INSERT INTO approved_host_ports (container_id, host_port, container_port, protocol, description)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(container_id, host_port, protocol) DO UPDATE SET
       container_port = excluded.container_port, description = excluded.description`
  ).run(p.container_id, p.host_port, p.container_port, p.protocol, p.description);
  return Number(result.lastInsertRowid);
}

export function removeApprovedHostPort(id: number): void {
  db.prepare('DELETE FROM approved_host_ports WHERE id = ?').run(id);
}

export function isHostPortApproved(containerId: string, hostPort: number, protocol: string): boolean {
  return !!db.prepare(
    'SELECT id FROM approved_host_ports WHERE container_id = ? AND host_port = ? AND protocol = ?'
  ).get(containerId, hostPort, protocol);
}

// ── Docker-socket registrations (blocker 15) ─────────────────────────────────
// See socket_registrations' CREATE TABLE comment above for why this exists.

export function registerSocketName(name: string): void {
  // Reset readiness for every explicit request.  The gateway must acknowledge
  // this registration again before the CLI tells the user it is safe to start
  // Compose; an old acknowledgement cannot prove a restarted gateway listens.
  db.prepare(`INSERT INTO socket_registrations (name, revision, ready_at)
              VALUES (?, lower(hex(randomblob(16))), NULL)
              ON CONFLICT(name) DO UPDATE SET revision = lower(hex(randomblob(16))), ready_at = NULL`)
    .run(name);
}

/**
 * Undo a registration — the counterpart `registerSocketName` never had.
 *
 * Two callers need this, both about not leaving a permanent phantom row
 * behind: `createAndStartContainer` (docker.ts), to roll back its own
 * registration when anything after it fails before the container is actually
 * up; and `pruneDeadSocketRegistrations` below, for a row whose container
 * existed and was served (ready_at set) but is no longer in Docker's live
 * list — e.g. removed by `docker rm` outside Huddle, since there is no
 * devcontainer "delete" route in this codebase to hook a cleanup into
 * instead. Safe to call for a name that was never registered (0 rows
 * affected, no error) so callers do not need to check first.
 */
export function unregisterSocketName(name: string): void {
  db.prepare('DELETE FROM socket_registrations WHERE name = ?').run(name);
}

/**
 * Drop registrations that are stale rather than merely not-yet-running.
 *
 * `ready_at IS NOT NULL` is the signal that separates the two: it means the
 * gateway already served this name's socket at least once, so the container
 * genuinely existed. If that name is now missing from `liveNames` (Docker's
 * current running list, from containerSnapshot()), the container is gone —
 * removed directly against the engine, since there is no delete route in
 * Huddle to have unregistered it. A row with `ready_at IS NULL` is left
 * alone no matter what: that is exactly the state `huddle migrate
 * --docker-socket` (and createAndStartContainer, briefly) put it in on
 * purpose, ahead of the container ever running — pruning on "not running yet"
 * would break that registration before it had a chance to be served.
 *
 * Called from buildContainerFeed(), which runs on every gateway poll (~1s,
 * see boot-gateway.ts) — kept to one indexed DELETE so that stays cheap.
 */
export function pruneDeadSocketRegistrations(liveNames: string[]): void {
  if (liveNames.length === 0) {
    db.prepare('DELETE FROM socket_registrations WHERE ready_at IS NOT NULL').run();
    return;
  }
  const placeholders = liveNames.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM socket_registrations WHERE ready_at IS NOT NULL AND name NOT IN (${placeholders})`
  ).run(...liveNames);
}

export function listRegisteredSocketNames(): string[] {
  return (db.prepare('SELECT name FROM socket_registrations ORDER BY name').all() as { name: string }[])
    .map((r) => r.name);
}

/** Included in the feed hash so re-registering an existing name repolls it. */
export function socketRegistrationRevisions(): Record<string, string> {
  const rows = db.prepare('SELECT name, revision FROM socket_registrations ORDER BY name').all() as { name: string; revision: string }[];
  return Object.fromEntries(rows.map((r) => [r.name, r.revision]));
}

export function markSocketReady(name: string): boolean {
  return db.prepare('UPDATE socket_registrations SET ready_at = unixepoch() WHERE name = ?').run(name).changes > 0;
}

export function socketNamesReady(names: string[]): boolean {
  if (names.length === 0) return true;
  const placeholders = names.map(() => '?').join(',');
  const row = db.prepare(`SELECT count(*) AS total, sum(ready_at IS NOT NULL) AS ready
                          FROM socket_registrations WHERE name IN (${placeholders})`).get(...names) as { total: number; ready: number };
  return row.total === names.length && row.ready === names.length;
}
