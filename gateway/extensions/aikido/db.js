'use strict';

// ── DB helpers ───────────────────────────────────────────────────────────────
// Verantwoordelijk voor: schema-initialisatie, workspace-CRUD en
// credentials opslaan/opvragen.

function ensureSchema(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS aikido_workspaces (
    name TEXT PRIMARY KEY,
    aikido_env_prefix TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    language TEXT NOT NULL,
    code_repo_name TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS aikido_credentials (
    env_prefix TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    api_key_enc TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`).run();
  // Migratie voor databases aangemaakt vóór api_key_enc aan het schema werd toegevoegd.
  // Op nieuwe databases mislukt dit altijd (kolom staat al in CREATE TABLE) — dat is verwacht.
  try { db.prepare(`ALTER TABLE aikido_credentials ADD COLUMN api_key_enc TEXT`).run(); } catch { /* verwachte fout */ }
}

const WS_COLUMNS = 'name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name';

function loadWorkspaces(db) {
  return db.prepare(`SELECT ${WS_COLUMNS} FROM aikido_workspaces ORDER BY name`).all();
}

function getWorkspace(db, name) {
  return db.prepare(`SELECT ${WS_COLUMNS} FROM aikido_workspaces WHERE name = ?`).get(name) || null;
}

// decrypt wordt meegegeven als parameter om circulaire afhankelijkheden te vermijden
function resolveCredentials(db, envPrefix, decrypt) {
  const row = db.prepare('SELECT client_id, client_secret_enc FROM aikido_credentials WHERE env_prefix = ?').get(envPrefix);
  if (row) {
    try { return { clientId: row.client_id, clientSecret: decrypt(row.client_secret_enc) }; } catch { /* fall through */ }
  }
  const clientId     = process.env[`${envPrefix}_CLIENT_ID`]     || '';
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`] || '';
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

function saveCredentials(db, envPrefix, clientId, encryptedSecret, encryptedApiKey) {
  db.prepare(`INSERT INTO aikido_credentials (env_prefix, client_id, client_secret_enc, api_key_enc, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(env_prefix) DO UPDATE SET client_id = excluded.client_id,
      client_secret_enc = excluded.client_secret_enc,
      api_key_enc = COALESCE(excluded.api_key_enc, api_key_enc),
      updated_at = unixepoch()`).run(envPrefix, clientId, encryptedSecret, encryptedApiKey);
}

module.exports = { ensureSchema, loadWorkspaces, getWorkspace, resolveCredentials, saveCredentials };
