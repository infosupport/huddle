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
  `);
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
