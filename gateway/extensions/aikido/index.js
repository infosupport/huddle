'use strict';

const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');
const https       = require('https');
const net         = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const tunnel      = require('tunnel-agent');

const KEY_PATH      = process.env.AIKIDO_KEY_PATH || '/data/.aikido-key';
const API_BASE      = 'https://app.aikido.dev/api/public/v1';
const TOKEN_URL     = 'https://app.aikido.dev/api/oauth/token';
const CACHE_TTL_MS  = 5 * 60 * 1000;

// ── Encryption ───────────────────────────────────────────────────────────────

function getOrCreateKey() {
  try {
    if (fs.existsSync(KEY_PATH)) return fs.readFileSync(KEY_PATH);
  } catch { /* fall through */ }
  const k = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH, k, { mode: 0o600 });
  } catch { /* ephemeral key */ }
  return k;
}

let _key = null;
function encKey() { if (!_key) _key = getOrCreateKey(); return _key; }

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

function decrypt(encoded) {
  const buf = Buffer.from(encoded, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct  = buf.subarray(12, buf.length - 16);
  const d   = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ── HTTP / Aikido API ────────────────────────────────────────────────────────

const _tunnelAgent = tunnel.httpsOverHttp({ proxy: { host: 'huddle', port: 80 }, rejectUnauthorized: false });

function httpsReq(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method, headers, agent: _tunnelAgent }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

const tokenCache = new Map();

async function getAccessToken(clientId, clientSecret) {
  const cached = tokenCache.get(clientId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = 'grant_type=client_credentials';
  const resp = await httpsReq('POST', TOKEN_URL, {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': String(Buffer.byteLength(body)),
  }, body);
  const data = JSON.parse(resp);
  tokenCache.set(clientId, { token: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000 });
  return data.access_token;
}

async function aikidoGet(token, apiPath, params) {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : '';
  const resp = await httpsReq('GET', `${API_BASE}${apiPath}${qs}`, { Authorization: `Bearer ${token}` });
  return JSON.parse(resp);
}

// ── Issues cache ─────────────────────────────────────────────────────────────

const issuesCache = new Map();
const inFlight    = new Map();

async function fetchAllIssues(envPrefix, creds) {
  const cached = issuesCache.get(envPrefix);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const existing = inFlight.get(envPrefix);
  if (existing) return existing;
  const promise = (async () => {
    const token    = await getAccessToken(creds.clientId, creds.clientSecret);
    const all      = [];
    let page       = 0;
    while (true) {
      const data  = await aikidoGet(token, '/open-issue-groups', { filter_status: 'open', per_page: 50, page });
      const batch = Array.isArray(data) ? data : (data.groups || []);
      if (!batch.length) break;
      all.push(...batch);
      if (batch.length < 50) break;
      page++;
    }
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    all.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (b.severity_score || 0) - (a.severity_score || 0));
    const summary = { total: all.length, critical: 0, high: 0, medium: 0, low: 0 };
    for (const i of all) { if (i.severity in summary) summary[i.severity]++; }
    const entry = { issues: all, summary, fetchedAt: Date.now() };
    issuesCache.set(envPrefix, entry);
    return entry;
  })();
  inFlight.set(envPrefix, promise);
  try { return await promise; } finally { inFlight.delete(envPrefix); }
}

function clearCache(envPrefix) {
  if (envPrefix) issuesCache.delete(envPrefix);
  else issuesCache.clear();
}

// ── Docker exec ──────────────────────────────────────────────────────────────

function dockerRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = [
      `${method} ${urlPath} HTTP/1.1`,
      'Host: localhost',
      'Content-Type: application/json',
      `Content-Length: ${payload ? Buffer.byteLength(payload) : 0}`,
      'Connection: close',
    ].join('\r\n') + '\r\n\r\n' + (payload ?? '');
    const sock = net.connect('/var/run/docker.sock');
    let raw = '';
    sock.on('data', d => { raw += d.toString(); });
    sock.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const status = parseInt((head.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10);
      const bodyStr = rest.join('\r\n\r\n').replace(/^[0-9a-f]+\r\n/gm, '').replace(/\r\n/g, '');
      try {
        const parsed = bodyStr ? JSON.parse(bodyStr) : {};
        if (status >= 400) reject(new Error(`Docker ${method} ${urlPath} → ${status}: ${bodyStr}`));
        else resolve(parsed);
      } catch { resolve({}); }
    });
    sock.on('error', reject);
    sock.write(headers);
  });
}

// ── Prompt generation ────────────────────────────────────────────────────────

function generateClaudePrompt(issues, ws) {
  const language = ws.language || 'java';
  const repoName = ws.code_repo_name || ws.name;
  let issueSection;
  if (issues.length === 1) {
    issueSection = `Kwetsbaarheid:\n${JSON.stringify(issues[0], null, 2)}`;
  } else {
    issueSection = `Er zijn ${issues.length} kwetsbaarheden:\n\n` +
      issues.map((i, n) => `### Issue ${n + 1}\n${JSON.stringify(i, null, 2)}`).join('\n\n');
  }
  return `Je bent een senior security engineer gespecialiseerd in ${language.toUpperCase()} applicaties.

Fix de volgende ${issues.length === 1 ? 'kwetsbaarheid' : `${issues.length} kwetsbaarheden`} in deze codebase:

## Beschikbare MCP Tools

| Tool | Beschrijving |
|------|-------------|
| \`aikido_issues_list\` | Open issues ophalen (filter met \`repo_name: "${repoName}"\`) |
| \`aikido_issue_details\` | Details van een specifiek issue |
| \`aikido_scan_repo\` | Scan triggeren na een fix |
| \`aikido_list_repos\` | Repositories ophalen |
| \`aikido_ignore_issue\` | Issue negeren als false positive |
| \`aikido_add_note\` | Notitie toevoegen aan een issue |

## Stappen

1. **Analyseer** — Zoek de root cause in de code.
2. **Fix** — Pas de code aan om de kwetsbaarheid op te lossen.
3. **Verificeer** — Gebruik \`aikido_list_repos\` → \`aikido_scan_repo\` → \`aikido_issues_list\` om te controleren.
4. **Documenteer** — \`aikido_add_note\` + schrijf \`aikido/SECURITY_FIX.md\`.

${issueSection}

Belangrijk: geen git commits, alleen noodzakelijke wijzigingen.`;
}

function generateIssueContext(issues, ws) {
  let content = `# Security Issue Context\n\n## Workspace\n**${ws.name}** (${ws.language || '?'})\n\n`;
  for (let n = 0; n < issues.length; n++) {
    const i = issues[n];
    const prefix = issues.length > 1 ? `### ${n + 1}. ` : '## ';
    content += `${prefix}${i.title || 'Onbekend'}\n`;
    content += `- **Severity**: ${i.severity || '?'} (score: ${i.severity_score ?? 'n.v.t.'})\n`;
    content += `- **Type**: ${i.type || 'n.v.t.'}\n`;
    content += `- **Package**: ${i.affected_package || 'n.v.t.'}\n\n`;
  }
  return content;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function initDb(db) {
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
  try { db.prepare(`ALTER TABLE aikido_credentials ADD COLUMN api_key_enc TEXT`).run(); } catch {}
}

function loadWorkspaces(db) {
  return db.prepare('SELECT name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name FROM aikido_workspaces ORDER BY name').all();
}

function getWorkspace(db, name) {
  return db.prepare('SELECT name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name FROM aikido_workspaces WHERE name = ?').get(name) || null;
}

function resolveCredentials(db, envPrefix) {
  const row = db.prepare('SELECT client_id, client_secret_enc FROM aikido_credentials WHERE env_prefix = ?').get(envPrefix);
  if (row) {
    try { return { clientId: row.client_id, clientSecret: decrypt(row.client_secret_enc) }; } catch { /* fall through */ }
  }
  const clientId     = process.env[`${envPrefix}_CLIENT_ID`]     || '';
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`] || '';
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

function hasCredentials(db, envPrefix) {
  return resolveCredentials(db, envPrefix) !== null;
}

// ── Issue filtering ──────────────────────────────────────────────────────────

function filterIssuesByRepo(issues, repoName) {
  if (!repoName) return issues;
  const needle = repoName.toLowerCase();
  return issues.filter(i =>
    (i.locations || []).some(l => ((l.code_repo_name || l.name || '')).toLowerCase() === needle)
  );
}

// ── Extension register ────────────────────────────────────────────────────────

module.exports.register = async function register(ctx) {
  const { app, db, log, getSetting, setSetting } = ctx;

  initDb(db);
  log('Aikido extensie geladen');

  // Workspaces - list
  app.get('/api/ext/aikido/workspaces', async () => {
    return loadWorkspaces(db).map(ws => ({
      name: ws.name,
      workspace_id: ws.workspace_id,
      language: ws.language,
      code_repo_name: ws.code_repo_name || null,
      repo_path: ws.repo_path,
      aikido_env_prefix: ws.aikido_env_prefix,
      hasCredentials: hasCredentials(db, ws.aikido_env_prefix),
    }));
  });

  // Workspaces - create
  app.post('/api/ext/aikido/workspaces', async (req, reply) => {
    const { name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name } = req.body;
    if (!name || !aikido_env_prefix || !repo_path || !workspace_id || !language) {
      return reply.code(400).send({ error: 'Verplichte velden: name, aikido_env_prefix, repo_path, workspace_id, language' });
    }
    const existing = getWorkspace(db, name);
    if (existing) return reply.code(409).send({ error: `Workspace "${name}" bestaat al` });
    db.prepare('INSERT INTO aikido_workspaces (name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, aikido_env_prefix, repo_path.replace(/\\/g, '/'), workspace_id, language, code_repo_name || null);
    return { ok: true };
  });

  // Workspaces - update
  app.put('/api/ext/aikido/workspaces/:name', async (req, reply) => {
    const ws = getWorkspace(db, req.params.name);
    if (!ws) return reply.code(404).send({ error: `Workspace "${req.params.name}" niet gevonden` });
    const { name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name } = req.body;
    if (name && name !== req.params.name && getWorkspace(db, name)) {
      return reply.code(409).send({ error: `Workspace "${name}" bestaat al` });
    }
    db.prepare(`UPDATE aikido_workspaces SET
      name = COALESCE(?, name),
      aikido_env_prefix = COALESCE(?, aikido_env_prefix),
      repo_path = COALESCE(?, repo_path),
      workspace_id = COALESCE(?, workspace_id),
      language = COALESCE(?, language),
      code_repo_name = ?
      WHERE name = ?`).run(
      name || null,
      aikido_env_prefix || null,
      repo_path ? repo_path.replace(/\\/g, '/') : null,
      workspace_id || null,
      language || null,
      code_repo_name !== undefined ? (code_repo_name || null) : ws.code_repo_name,
      req.params.name
    );
    return { ok: true };
  });

  // Workspaces - delete
  app.delete('/api/ext/aikido/workspaces/:name', async (req, reply) => {
    const ws = getWorkspace(db, req.params.name);
    if (!ws) return reply.code(404).send({ error: `Workspace "${req.params.name}" niet gevonden` });
    db.prepare('DELETE FROM aikido_workspaces WHERE name = ?').run(req.params.name);
    return { ok: true };
  });

  // Issues per workspace
  app.get('/api/ext/aikido/workspaces/:name/issues', async (req, reply) => {
    const ws = getWorkspace(db, req.params.name);
    if (!ws) return reply.code(404).send({ error: `Workspace "${req.params.name}" niet gevonden` });
    const creds = resolveCredentials(db, ws.aikido_env_prefix);
    if (!creds) return reply.code(401).send({ error: 'no_credentials', message: 'Geen Aikido credentials geconfigureerd' });

    const page    = parseInt(req.query?.page    || '0', 10);
    const perPage = parseInt(req.query?.per_page || '20', 10);
    const sev     = req.query?.severity || undefined;

    try {
      const cached = await fetchAllIssues(ws.aikido_env_prefix, creds);
      const filtered = filterIssuesByRepo(cached.issues, ws.code_repo_name);
      const summary = { total: filtered.length, critical: 0, high: 0, medium: 0, low: 0 };
      for (const i of filtered) { if (i.severity in summary) summary[i.severity]++; }
      let result = sev ? filtered.filter(i => i.severity === sev) : filtered;
      const start  = page * perPage;
      const groups = result.slice(start, start + perPage);
      return { groups, summary, page, per_page: perPage, filtered_total: result.length,
        all_filtered_ids: result.map(i => i.id), cached_at: cached.fetchedAt };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // Refresh cache
  app.post('/api/ext/aikido/workspaces/:name/refresh', async (req) => {
    const ws = getWorkspace(db, req.params.name);
    if (ws) clearCache(ws.aikido_env_prefix);
    return { ok: true };
  });

  // Overview (summaries per workspace)
  app.get('/api/ext/aikido/overview', async () => {
    const workspaces = loadWorkspaces(db);
    const entries = await Promise.all(workspaces.map(async ws => {
      const creds = resolveCredentials(db, ws.aikido_env_prefix);
      if (!creds) return [ws.name, null];
      try {
        const cached   = await fetchAllIssues(ws.aikido_env_prefix, creds);
        const filtered = filterIssuesByRepo(cached.issues, ws.code_repo_name);
        const s = { total: filtered.length, critical: 0, high: 0, medium: 0, low: 0 };
        for (const i of filtered) { if (i.severity in s) s[i.severity]++; }
        return [ws.name, s];
      } catch (err) { console.error(`Failed to fetch Aikido issues for workspace ${ws.name}:`, err); return [ws.name, null]; }
    }));
    return Object.fromEntries(entries);
  });

  // Credentials - get
  app.get('/api/ext/aikido/credentials/:envPrefix', async (req) => {
    const row = db.prepare('SELECT client_id, api_key_enc, updated_at FROM aikido_credentials WHERE env_prefix = ?').get(req.params.envPrefix);
    if (!row) return { env_prefix: req.params.envPrefix, client_id: null, has_secret: false, has_api_key: false };
    return { env_prefix: req.params.envPrefix, client_id: row.client_id, has_secret: true, has_api_key: !!row.api_key_enc, updated_at: row.updated_at };
  });

  // Credentials - upsert
  app.post('/api/ext/aikido/credentials/:envPrefix', async (req, reply) => {
    const { client_id, client_secret, api_key } = req.body || {};
    if (!client_id || !client_secret) return reply.code(400).send({ error: 'client_id en client_secret zijn verplicht' });
    const enc    = encrypt(client_secret);
    const apiEnc = api_key ? encrypt(api_key) : null;
    db.prepare(`INSERT INTO aikido_credentials (env_prefix, client_id, client_secret_enc, api_key_enc, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(env_prefix) DO UPDATE SET client_id = excluded.client_id,
        client_secret_enc = excluded.client_secret_enc,
        api_key_enc = COALESCE(excluded.api_key_enc, api_key_enc),
        updated_at = unixepoch()`).run(req.params.envPrefix, client_id, enc, apiEnc);
    let validated = false, validationError = null;
    try { await getAccessToken(client_id, client_secret); validated = true; } catch (err) { validationError = err.message; }
    return { ok: true, validated, validation_error: validationError };
  });

  // Credentials - delete
  app.delete('/api/ext/aikido/credentials/:envPrefix', async (req) => {
    db.prepare('DELETE FROM aikido_credentials WHERE env_prefix = ?').run(req.params.envPrefix);
    return { ok: true };
  });

  // Globale MCP API key
  app.get('/api/ext/aikido/settings/mcp-api-key', async () => {
    return { has_key: !!getSetting('mcp_api_key') };
  });

  app.post('/api/ext/aikido/settings/mcp-api-key', async (req, reply) => {
    const { api_key } = req.body || {};
    if (!api_key) return reply.code(400).send({ error: 'api_key is verplicht' });
    setSetting('mcp_api_key', encrypt(api_key));
    return { ok: true };
  });

  app.delete('/api/ext/aikido/settings/mcp-api-key', async () => {
    setSetting('mcp_api_key', '');
    return { ok: true };
  });

  // Inject: schrijf context + MCP server naar een devcontainer
  app.post('/api/ext/aikido/workspaces/:name/inject', async (req, reply) => {
    const ws = getWorkspace(db, req.params.name);
    if (!ws) return reply.code(404).send({ error: `Workspace "${req.params.name}" niet gevonden` });

    const body          = req.body || {};
    const containerName = body.container_name;
    if (!containerName) return reply.code(400).send({ error: 'container_name is verplicht' });

    let issues = body.issues || [];
    if (!issues.length && Array.isArray(body.issue_ids) && body.issue_ids.length) {
      const creds = resolveCredentials(db, ws.aikido_env_prefix);
      if (!creds) return reply.code(401).send({ error: 'no_credentials' });
      const cached = issuesCache.get(ws.aikido_env_prefix);
      if (!cached) {
        const fetched = await fetchAllIssues(ws.aikido_env_prefix, creds);
        const idSet   = new Set(body.issue_ids.map(String));
        issues = fetched.issues.filter(i => idSet.has(String(i.id)));
      } else {
        const idSet = new Set(body.issue_ids.map(String));
        issues = cached.issues.filter(i => idSet.has(String(i.id)));
      }
    }
    if (!Array.isArray(issues) || !issues.length) return reply.code(400).send({ error: 'issues of issue_ids vereist' });

    try {
      const info      = await dockerRequest('GET', `/containers/${encodeURIComponent(containerName)}/json`);
      const workspace = info.Config?.Labels?.['com.intellij.devcontainer.workspace.path'] || '/workspaces';
      const creds     = resolveCredentials(db, ws.aikido_env_prefix);
      const mcpJs     = fs.readFileSync(path.join(__dirname, 'aikido-mcp-server.js'), 'utf-8');

      const claudeJson = JSON.stringify({
        mcpServers: {
          'aikido-verify': {
            type: 'stdio', command: 'node',
            args: ['/usr/local/lib/aikido-mcp-server.js'],
            env: { AIKIDO_CLIENT_ID: creds?.clientId ?? '', AIKIDO_CLIENT_SECRET: creds?.clientSecret ?? '', AIKIDO_API_KEY: (() => { try { const v = getSetting('mcp_api_key'); return v ? decrypt(v) : ''; } catch { return ''; } })() },
          },
        },
      }, null, 2);

      const aikidoDir = `${workspace}/aikido`;

      const files = {
        [`${aikidoDir}/AIKIDO_CLAUDE.md`]:   generateClaudePrompt(issues, ws),
        [`${aikidoDir}/AIKIDO_CONTEXT.md`]:  generateIssueContext(issues, ws),
        [`${aikidoDir}/AIKIDO_ISSUES.json`]: JSON.stringify(issues, null, 2),
        ['/usr/local/bin/aikido-fix']:       `#!/bin/bash\ncd ${workspace}\nclaude "lees aikido/AIKIDO_CLAUDE.md en voer alle instructies uit"\n`,
        ['/usr/local/lib/aikido-mcp-server.js']: mcpJs,
      };

      // Maak doelmappen aan in de container
      const mkdirExec = await dockerRequest('POST', `/containers/${info.Id}/exec`, {
        User: 'root', Cmd: ['sh', '-c', `mkdir -p ${aikidoDir} /usr/local/lib /usr/local/bin`],
        AttachStdout: false, AttachStderr: false,
      });
      await dockerRequest('POST', `/exec/${mkdirExec.Id}/start`, { Detach: true });

      // Kopieer elk bestand via een tijdelijk hostbestand + docker cp (async, non-blocking)
      const tmpFiles = [];
      try {
        for (const [containerPath, content] of Object.entries(files)) {
          const tmpPath = `/tmp/huddle-inject-${crypto.randomBytes(8).toString('hex')}.tmp`;
          tmpFiles.push(tmpPath);
          await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
          await execFileAsync('docker', ['cp', tmpPath, `${info.Id}:${containerPath}`]);
        }
      } finally {
        for (const tmpPath of tmpFiles) {
          try { await fs.promises.unlink(tmpPath); } catch (err) { console.error(`Failed to cleanup tmp file ${tmpPath}:`, err); }
        }
      }

      const mergeScript  = `node -e 'const fs=require("fs"),p="/home/vscode/.claude.json";let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"));}catch{}const n=${JSON.stringify(JSON.parse(claudeJson))};s.mcpServers=Object.assign(s.mcpServers||{},n.mcpServers);fs.writeFileSync(p,JSON.stringify(s,null,2));try{fs.chownSync(p,1000,1000);}catch{}'`;
      const postCopyScript = `chmod +x /usr/local/bin/aikido-fix && chown -R vscode:vscode ${workspace} && ${mergeScript}`;

      const exec = await dockerRequest('POST', `/containers/${info.Id}/exec`, {
        User: 'root', Cmd: ['sh', '-c', postCopyScript], AttachStdout: false, AttachStderr: false,
      });
      await dockerRequest('POST', `/exec/${exec.Id}/start`, { Detach: true });

      // Gitignore update als aparte exec zodat een falende hoofdscript het niet blokkeert
      const gitignoreScript = `grep -qxF /aikido ${workspace}/.gitignore 2>/dev/null || printf '\\n/aikido\\n' >> ${workspace}/.gitignore`;
      const giExec = await dockerRequest('POST', `/containers/${info.Id}/exec`, {
        User: 'root', Cmd: ['sh', '-c', gitignoreScript], AttachStdout: false, AttachStderr: false,
      });
      await dockerRequest('POST', `/exec/${giExec.Id}/start`, { Detach: true });

      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
};
