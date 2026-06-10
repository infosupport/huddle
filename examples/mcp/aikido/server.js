// Aikido Security MCP-server — Node.js ESM, geen externe dependencies buiten de SDK.
// Huddle injecteert AIKIDO_CLIENT_ID en AIKIDO_CLIENT_SECRET als omgevingsvariabelen.
// Transport: SSE op GET /sse  +  POST /messages?sessionId=<id>

import { McpServer }         from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z }                 from 'zod';
import http                  from 'node:http';

const CLIENT_ID     = process.env.AIKIDO_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.AIKIDO_CLIENT_SECRET || '';
const REPO_NAME     = process.env.AIKIDO_REPO_NAME     || '';
const PORT          = parseInt(process.env.PORT || '8080', 10);
const MCP_BASE      = (process.env.HUDDLE_MCP_BASE || '').replace(/\/$/, '');

const BASE_URL = 'https://app.aikido.dev';

// ── OAuth2 token (client credentials) ───────────────────────────────────────

let tokenCache = null;

async function getToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('AIKIDO_CLIENT_ID en AIKIDO_CLIENT_SECRET zijn niet geconfigureerd.');

  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE_URL}/api/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Aikido token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

async function aikidoGet(path) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) { tokenCache = null; throw new Error('Aikido: token verlopen, opnieuw proberen.'); }
  if (!res.ok) throw new Error(`Aikido ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Gepagineerde issues ───────────────────────────────────────────────────────

async function fetchAllIssues(severity, repoName) {
  const issues = [];
  let page = 0;
  while (true) {
    const params = new URLSearchParams({ filter_status: 'open', per_page: '20', page: String(page) });
    const data = await aikidoGet(`/api/public/v1/open-issue-groups?${params}`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const issue of data) {
      if (severity && issue.severity !== severity) continue;
      const repo = issue.locations?.[0]?.code_repo_name ?? '';
      if (repoName && repo !== repoName) continue;
      issues.push({
        id:             String(issue.id),
        title:          issue.title,
        severity:       issue.severity,
        severity_score: issue.severity_score,
        cve_ids:        issue.related_cve_ids ?? [],
        locations:      (issue.locations ?? []).map(l => ({
          repo_name: l.code_repo_name, file_path: l.file_path, line: l.line,
        })),
      });
    }
    page++;
  }
  return issues;
}

// ── MCP server factory ────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({ name: 'aikido', version: '1.0.0' });

  server.tool(
    'get_issues',
    'Haal open Aikido Security-issues op, optioneel gefilterd op severity of repository.',
    {
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional()
        .describe('Filter op severity'),
      repo_name: z.string().optional()
        .describe('Filter op repository-naam (code_repo_name)'),
    },
    async ({ severity, repo_name }) => {
      try {
        const issues = await fetchAllIssues(severity, repo_name ?? REPO_NAME);
        if (!issues.length) return { content: [{ type: 'text', text: 'Geen open issues gevonden.' }] };
        return { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get_issue',
    'Haal één Aikido Security-issue op op ID.',
    {
      issue_id: z.union([z.string(), z.number()]).describe('Het issue-ID'),
    },
    async ({ issue_id }) => {
      try {
        const all = await fetchAllIssues();
        const issue = all.find(i => String(i.id) === String(issue_id));
        if (!issue) return { content: [{ type: 'text', text: `Issue ${issue_id} niet gevonden.` }] };
        return { content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
      }
    },
  );

  return server;
}

// ── SSE HTTP-server ───────────────────────────────────────────────────────────

const transports = new Map();

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/sse') {
    const transport = new SSEServerTransport(`${MCP_BASE}/messages`, res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => transports.delete(transport.sessionId));
    await createServer().connect(transport);
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/messages')) {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const transport = sessionId ? transports.get(sessionId) : null;
    if (!transport) { res.writeHead(404); res.end('Sessie niet gevonden'); return; }
    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Niet gevonden');
});

httpServer.listen(PORT, () => {
  console.log(`[aikido-mcp] luistert op :${PORT}`);
});
