'use strict';

const https  = require('https');
const tunnel = require('tunnel-agent');

// ── HTTP / Aikido API ────────────────────────────────────────────────────────
// Verantwoordelijk voor: HTTP-hulpfuncties, OAuth-token ophalen,
// paginerende API-calls, en de issues-cache.

const API_BASE     = 'https://app.aikido.dev/api/public/v1';
const TOKEN_URL    = 'https://app.aikido.dev/api/oauth/token';
const CACHE_TTL_MS = 5 * 60 * 1000;

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
    const token = await getAccessToken(creds.clientId, creds.clientSecret);
    const all   = [];
    let page    = 0;
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

function filterIssuesByRepo(issues, repoName) {
  if (!repoName) return issues;
  const needle = repoName.toLowerCase();
  return issues.filter(i =>
    (i.locations || []).some(l => ((l.code_repo_name || l.name || '')).toLowerCase() === needle)
  );
}

module.exports = { fetchAllIssues, clearCache, filterIssuesByRepo, getAccessToken, issuesCache };
