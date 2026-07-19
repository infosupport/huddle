'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const { ensureSchema, loadWorkspaces, getWorkspace, resolveCredentials, saveCredentials } = require('./db');
const { fetchAllIssues, clearCache, filterIssuesByRepo, getAccessToken, issuesCache }    = require('./api-client');
const { dockerRequest, writeScript }                                                       = require('./docker-io');

const KEY_PATH = process.env.AIKIDO_KEY_PATH || '/data/.aikido-key';

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
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
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

// ── Prompt generation ────────────────────────────────────────────────────────

function generateClaudePrompt(issues, ws) {
  const language = ws.language || 'java';
  const repoName = ws.code_repo_name || ws.name;
  let issueSection;
  if (issues.length === 1) {
    issueSection = `Vulnerability:\n${JSON.stringify(issues[0], null, 2)}`;
  } else {
    issueSection = `There are ${issues.length} vulnerabilities:\n\n` +
      issues.map((i, n) => `### Issue ${n + 1}\n${JSON.stringify(i, null, 2)}`).join('\n\n');
  }
  return `You are a senior security engineer specializing in ${language.toUpperCase()} applications.

Fix the following ${issues.length === 1 ? 'vulnerability' : `${issues.length} vulnerabilities`} in this codebase:

## Available MCP Tools

| Tool | Description |
|------|-------------|
| \`aikido_issues_list\` | Get open issues (filter with \`repo_name: "${repoName}"\`) |
| \`aikido_issue_details\` | Get details of a specific issue |
| \`aikido_scan_repo\` | Trigger scan after fix |
| \`aikido_list_repos\` | List repositories |
| \`aikido_ignore_issue\` | Mark issue as false positive |
| \`aikido_add_note\` | Add note to issue |

## Steps

1. **Analyze** — Find the root cause in the code.
2. **Fix** — Modify the code to resolve the vulnerability.
3. **Verify** — Use \`aikido_list_repos\` → \`aikido_scan_repo\` → \`aikido_issues_list\` to verify.
4. **Document** — \`aikido_add_note\` + write \`aikido/SECURITY_FIX.md\`.

${issueSection}

Important: no git commits, only necessary changes.`;
}

function generateIssueContext(issues, ws) {
  let content = `# Security Issue Context\n\n## Workspace\n**${ws.name}** (${ws.language || '?'})\n\n`;
  for (let n = 0; n < issues.length; n++) {
    const i = issues[n];
    const prefix = issues.length > 1 ? `### ${n + 1}. ` : '## ';
    content += `${prefix}${i.title || 'Unknown'}\n`;
    content += `- **Severity**: ${i.severity || '?'} (score: ${i.severity_score ?? 'n/a'})\n`;
    content += `- **Type**: ${i.type || 'n/a'}\n`;
    content += `- **Package**: ${i.affected_package || 'n/a'}\n\n`;
  }
  return content;
}

// ── Extension register ────────────────────────────────────────────────────────

module.exports.register = async function register(ctx) {
  const { app, db, log, getSetting, setSetting } = ctx;

  ensureSchema(db);
  log('Aikido extension loaded');

  // Bind decrypt in resolveCredentials via een wrapper zodat db.js crypto-vrij blijft
  const resolveCreds = (envPrefix) => resolveCredentials(db, envPrefix, decrypt);
  const hasCreds     = (envPrefix) => resolveCreds(envPrefix) !== null;

  // Workspaces - list
  app.get('/api/ext/aikido/workspaces', async () => {
    return loadWorkspaces(db).map(ws => ({
      name: ws.name,
      workspace_id: ws.workspace_id,
      language: ws.language,
      code_repo_name: ws.code_repo_name || null,
      repo_path: ws.repo_path,
      aikido_env_prefix: ws.aikido_env_prefix,
      hasCredentials: hasCreds(ws.aikido_env_prefix),
    }));
  });

  // Workspaces - create
  app.post('/api/ext/aikido/workspaces', async (req, reply) => {
    const { name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name } = req.body;
    if (!name || !aikido_env_prefix || !repo_path || !workspace_id || !language) {
      return reply.code(400).send({ error: 'Required fields: name, aikido_env_prefix, repo_path, workspace_id, language' });
    }
    const existing = getWorkspace(db, name);
    if (existing) return reply.code(409).send({ error: `Workspace "${name}" already exists` });
    db.prepare('INSERT INTO aikido_workspaces (name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, aikido_env_prefix, repo_path.replace(/\\/g, '/'), workspace_id, language, code_repo_name || null);
    return { ok: true };
  });

  // Workspaces - update
  app.put('/api/ext/aikido/workspaces/:name', async (req, reply) => {
    const ws = getWorkspace(db, req.params.name);
    if (!ws) return reply.code(404).send({ error: `Workspace "${req.params.name}" not found` });
    const { name, aikido_env_prefix, repo_path, workspace_id, language, code_repo_name } = req.body;
    if (name && name !== req.params.name && getWorkspace(db, name)) {
      return reply.code(409).send({ error: `Workspace "${name}" already exists` });
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
    if (!ws) return reply.code(404).send({ error: `Workspace "${req.params.name}" not found` });
    db.prepare('DELETE FROM aikido_workspaces WHERE name = ?').run(req.params.name);
    return { ok: true };
  });

  // Issues per workspace
  app.get('/api/ext/aikido/workspaces/:name/issues', async (req, reply) => {
    const ws = getWorkspace(db, req.params.name);
    if (!ws) return reply.code(404).send({ error: `Workspace "${req.params.name}" not found` });
    const creds = resolveCreds(ws.aikido_env_prefix);
    if (!creds) return reply.code(401).send({ error: 'no_credentials', message: 'No Aikido credentials configured' });

    const page    = parseInt(req.query?.page    || '0', 10);
    const perPage = parseInt(req.query?.per_page || '20', 10);
    const sev     = req.query?.severity || undefined;

    try {
      const cached   = await fetchAllIssues(ws.aikido_env_prefix, creds);
      const filtered = filterIssuesByRepo(cached.issues, ws.code_repo_name);
      const summary  = { total: filtered.length, critical: 0, high: 0, medium: 0, low: 0 };
      for (const i of filtered) { if (i.severity in summary) summary[i.severity]++; }
      let result   = sev ? filtered.filter(i => i.severity === sev) : filtered;
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
    const results    = {};
    for (const ws of workspaces) {
      const creds = resolveCreds(ws.aikido_env_prefix);
      if (!creds) { results[ws.name] = null; continue; }
      try {
        const cached   = await fetchAllIssues(ws.aikido_env_prefix, creds);
        const filtered = filterIssuesByRepo(cached.issues, ws.code_repo_name);
        const s        = { total: filtered.length, critical: 0, high: 0, medium: 0, low: 0 };
        for (const i of filtered) { if (i.severity in s) s[i.severity]++; }
        results[ws.name] = s;
      } catch { results[ws.name] = null; }
    }
    return results;
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
    if (!client_id || !client_secret) return reply.code(400).send({ error: 'client_id and client_secret are required' });
    const enc    = encrypt(client_secret);
    const apiEnc = api_key ? encrypt(api_key) : null;
    saveCredentials(db, req.params.envPrefix, client_id, enc, apiEnc);
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
    if (!api_key) return reply.code(400).send({ error: 'api_key is required' });
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
    if (!ws) return reply.code(404).send({ error: `Workspace "${req.params.name}" not found` });

    const body          = req.body || {};
    const containerName = body.container_name;
    if (!containerName) return reply.code(400).send({ error: 'container_name is required' });

    let issues = body.issues || [];
    if (!issues.length && Array.isArray(body.issue_ids) && body.issue_ids.length) {
      const creds = resolveCreds(ws.aikido_env_prefix);
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
    if (!Array.isArray(issues) || !issues.length) return reply.code(400).send({ error: 'issues or issue_ids required' });

    try {
      const info      = await dockerRequest('GET', `/containers/${encodeURIComponent(containerName)}/json`);
      const workspace = info.Config?.Labels?.['com.intellij.devcontainer.workspace.path'] || '/workspaces';
      const creds     = resolveCreds(ws.aikido_env_prefix);
      const mcpJs     = fs.readFileSync(path.join(__dirname, 'aikido-mcp-server.js'), 'utf-8');

      const claudeJson = JSON.stringify({
        mcpServers: {
          'aikido-verify': {
            type: 'stdio', command: 'node',
            args: ['/usr/local/lib/aikido-mcp-server.js'],
            env: {
              AIKIDO_CLIENT_ID:     creds?.clientId     ?? '',
              AIKIDO_CLIENT_SECRET: creds?.clientSecret ?? '',
              AIKIDO_API_KEY: (() => { try { const v = getSetting('mcp_api_key'); return v ? decrypt(v) : ''; } catch { return ''; } })(),
            },
          },
        },
      }, null, 2);

      const aikidoDir = `${workspace}/aikido`;
      const files = {
        [`${aikidoDir}/AIKIDO_CLAUDE.md`]:       generateClaudePrompt(issues, ws),
        [`${aikidoDir}/AIKIDO_CONTEXT.md`]:      generateIssueContext(issues, ws),
        [`${aikidoDir}/AIKIDO_ISSUES.json`]:     JSON.stringify(issues, null, 2),
        ['/usr/local/bin/aikido-fix']:            `#!/bin/bash\ncd ${workspace}\nclaude "lees aikido/AIKIDO_CLAUDE.md en voer alle instructies uit"\n`,
        ['/usr/local/lib/aikido-mcp-server.js']: mcpJs,
      };

      await writeScript(info, files, claudeJson, workspace);
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
};
