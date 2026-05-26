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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_domain_container
      ON rules(domain, COALESCE(container_id, ''));
    CREATE TABLE IF NOT EXISTS docker_grants (
      container_id TEXT PRIMARY KEY,
      until INTEGER NOT NULL
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
  `);

  const cols = db.prepare("PRAGMA table_info(rules)").all() as {name:string}[];
  if (!cols.some(c => c.name === 'expires_at')) {
    db.exec('ALTER TABLE rules ADD COLUMN expires_at INTEGER');
  }

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

export function logAudit(entry: AuditEntry): void {
  try {
    insertAudit().run(
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
  } catch (err) { console.error('[audit] log failed:', err); }
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
