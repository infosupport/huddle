import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || '/data/huddle.db';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
    CREATE TABLE IF NOT EXISTS folder_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host_path TEXT NOT NULL DEFAULT '',
      volume_name TEXT NOT NULL DEFAULT '',
      container_path TEXT NOT NULL,
      read_only INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
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
  `);

  const cols = db.prepare("PRAGMA table_info(rules)").all() as {name:string}[];
  if (!cols.some(c => c.name === 'expires_at')) {
    db.exec('ALTER TABLE rules ADD COLUMN expires_at INTEGER');
  }
  if (!cols.some(c => c.name === 'path_pattern')) {
    db.exec('ALTER TABLE rules ADD COLUMN path_pattern TEXT');
  }
  // path_mode markeert een host-only regel als "pad-allowlist": het kale domein
  // is dan dicht (status deny), maar onbekende subpaden worden als 'requested'
  // opgevoerd zodat de operator ze één voor één kan toestaan.
  if (!cols.some(c => c.name === 'path_mode')) {
    db.exec('ALTER TABLE rules ADD COLUMN path_mode INTEGER NOT NULL DEFAULT 0');
  }
  // last_path bewaart het laatst geziene volledige pad dat een (gegroepeerde)
  // requested-padregel triggerde, als concreet voorbeeld voor de operator.
  if (!cols.some(c => c.name === 'last_path')) {
    db.exec('ALTER TABLE rules ADD COLUMN last_path TEXT');
  }

  // Domeinen worden voortaan canoniek (lowercase) opgeslagen zodat de exacte
  // lookup en de wildcard-match op dezelfde vorm werken (finding #3). Migreer
  // bestaande rijen idempotent naar lowercase VÓÓR de dedup hieronder, zodat
  // case-varianten (`GIST.github.com` vs `gist.github.com`) samenvallen en de
  // dedup ze tot één rij terugbrengt in plaats van op de unieke index te botsen.
  db.exec('UPDATE rules SET domain = lower(domain) WHERE domain <> lower(domain)');

  // Uniciteit geldt nu op (domain, container, pad): meerdere padregels per
  // domein moeten naast elkaar kunnen bestaan. De oude domain+container index
  // wordt vervangen.
  // Opschonen voorkomt dat een migratie crasht wanneer oude data per ongeluk
  // meerdere rijen met dezelfde unieke sleutel bevat. NOCASE in de GROUP BY
  // zodat de dedup dezelfde hoofdletter-ongevoeligheid hanteert als de index.
  db.exec(`
    DELETE FROM rules
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM rules
      GROUP BY domain COLLATE NOCASE, COALESCE(container_id, ''), COALESCE(path_pattern, '')
    )
  `);
  db.exec('DROP INDEX IF EXISTS idx_rules_domain_container');
  // De oude index kon nog zonder NOCASE bestaan; herbouw hem case-insensitief.
  db.exec('DROP INDEX IF EXISTS idx_rules_domain_container_path');
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

// ── Docker action policies (fijnmazige rechten per actie) ────────────────────
// Alleen expliciete overrides staan in de db; ontbreekt een rij, dan geldt de
// default uit de actie-catalogus (docker-actions.ts).

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

export interface AuditEntry {
  containerId: string | null;
  domain: string;
  port?: number | null;
  action: string;
  ruleId?: number | null;
  method?: string | null;
  path?: string | null;
  reqHeaders?: string | null;
  reqBody?: string | null;
  resStatus?: number | null;
  resHeaders?: string | null;
  resBody?: string | null;
}

// Insert één audit-rij. Geeft het nieuwe row-id terug (of null bij fout) zodat
// een in-flight request meteen gelogd kan worden en later via
// updateAuditResponse aangevuld met de response.
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
export interface AuditResponse {
  reqBody?: string | null;
  resStatus?: number | null;
  resHeaders?: string | null;
  resBody?: string | null;
}

// Vul de response-velden (en de inmiddels volledig gebufferde req_body) aan op
// een eerder ingevoegde in-flight audit-rij.
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

// ── Folder Mappings ───────────────────────────────────────────────────────────

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

export function listFolderMappings(): FolderMapping[] {
  return db.prepare('SELECT * FROM folder_mappings ORDER BY sort_order ASC, id ASC').all() as FolderMapping[];
}

export function getFolderMapping(id: number): FolderMapping | undefined {
  return db.prepare('SELECT * FROM folder_mappings WHERE id = ?').get(id) as FolderMapping | undefined;
}

export function createFolderMapping(m: Omit<FolderMapping, 'id'>): number {
  const result = db.prepare(
    `INSERT INTO folder_mappings (name, host_path, volume_name, container_path, read_only, enabled, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(m.name, m.host_path, m.volume_name, m.container_path, m.read_only, m.enabled, m.sort_order);
  return Number(result.lastInsertRowid);
}

// De kolommen die via update gewijzigd mogen worden. De TS-`Partial<>` is enkel
// een compile-time garantie — op runtime komt `m` rechtstreeks uit de request-
// body. Zonder deze allowlist werden de JSON-sleutels ongefilterd als SQL-
// identifiers geïnterpoleerd, wat SQL-injectie via een geprepareerde sleutel
// mogelijk maakte (finding #9, bv. `container_path = (SELECT ...), name`).
const FOLDER_MAPPING_COLUMNS: ReadonlyArray<keyof Omit<FolderMapping, 'id'>> = [
  'name', 'host_path', 'volume_name', 'container_path', 'read_only', 'enabled', 'sort_order',
];

// Valideer de update-sleutels tegen de kolom-allowlist. Puur (geen DB) zodat de
// SQL-injectie-afweer (finding #9) los testbaar is. Retourneert de toegestane
// sleutels; gooit op elke onbekende sleutel (fail-closed).
export function validateFolderMappingKeys(m: object): Array<keyof Omit<FolderMapping, 'id'>> {
  const allowed = FOLDER_MAPPING_COLUMNS as ReadonlyArray<string>;
  const unknown = Object.keys(m).filter(k => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`unknown folder-mapping field(s): ${unknown.join(', ')}`);
  }
  return Object.keys(m).filter((k): k is keyof Omit<FolderMapping, 'id'> => allowed.includes(k));
}

export function updateFolderMapping(id: number, m: Partial<Omit<FolderMapping, 'id'>>): void {
  // Alleen bekende kolommen accepteren; sleutels worden zo nooit uit caller-input
  // in de SQL-tekst gezet.
  const keys = validateFolderMappingKeys(m);
  if (keys.length === 0) return;
  const fields = keys.map(k => `${k} = ?`).join(', ');
  const values = [...keys.map(k => (m as Record<string, unknown>)[k]), id];
  db.prepare(`UPDATE folder_mappings SET ${fields} WHERE id = ?`).run(...values);
}

export function deleteFolderMapping(id: number): void {
  db.prepare('DELETE FROM folder_mappings WHERE id = ?').run(id);
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
