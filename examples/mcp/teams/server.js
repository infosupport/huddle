// Microsoft Teams MCP-server — Node.js ESM, geen externe dependencies buiten de SDK.
// Huddle injecteert TEAMS_TENANT_ID, TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET als env vars.
// Transport: SSE op GET /sse  +  POST /messages?sessionId=<id>

import { McpServer }         from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z }                 from 'zod';
import http                  from 'node:http';

const TENANT_ID     = process.env.TEAMS_TENANT_ID     || '';
const CLIENT_ID     = process.env.TEAMS_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.TEAMS_CLIENT_SECRET || '';
const ALLOWED_UPNS  = (process.env.TEAMS_ALLOWED_UPNS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PORT          = parseInt(process.env.PORT || '8080', 10);
const MCP_BASE      = (process.env.HUDDLE_MCP_BASE || '').replace(/\/$/, '');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── OAuth2 token (client credentials) ────────────────────────────────────────

let tokenCache = null;

async function getToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('TEAMS_TENANT_ID, TEAMS_CLIENT_ID en TEAMS_CLIENT_SECRET zijn niet geconfigureerd.');
  }

  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope:         'https://graph.microsoft.com/.default',
    }),
  });
  if (!res.ok) throw new Error(`Teams token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

async function graph(method, path, body) {
  const token = await getToken();
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${GRAPH_BASE}${path}`, opts);
  if (res.status === 401) { tokenCache = null; throw new Error('Teams: token verlopen.'); }
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// ── MCP server factory ────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({ name: 'teams', version: '1.0.0' });

  server.tool(
    'list_teams',
    'Haal de Teams-groepen op waar de applicatie toegang toe heeft.',
    {},
    async () => {
      try {
        const data = await graph('GET', '/groups?$filter=resourceProvisioningOptions/Any(x:x eq \'Team\')&$select=id,displayName');
        const teams = (data.value ?? []).map(t => `${t.displayName} (${t.id})`).join('\n');
        return { content: [{ type: 'text', text: teams || 'Geen teams gevonden.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'list_channels',
    'Haal de kanalen op van een Teams-groep.',
    { team_id: z.string().describe('Het Teams-groep ID') },
    async ({ team_id }) => {
      try {
        const data = await graph('GET', `/teams/${team_id}/channels?$select=id,displayName`);
        const channels = (data.value ?? []).map(c => `${c.displayName} (${c.id})`).join('\n');
        return { content: [{ type: 'text', text: channels || 'Geen kanalen gevonden.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'send_channel_message',
    'Stuur een bericht naar een Teams-kanaal.',
    {
      team_id:    z.string().describe('Het Teams-groep ID'),
      channel_id: z.string().describe('Het kanaal ID'),
      message:    z.string().min(1).describe('De berichttekst'),
    },
    async ({ team_id, channel_id, message }) => {
      try {
        await graph('POST', `/teams/${team_id}/channels/${channel_id}/messages`, {
          body: { contentType: 'text', content: message },
        });
        return { content: [{ type: 'text', text: 'Bericht verstuurd.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'send_direct_message',
    'Stuur een direct bericht naar een Teams-gebruiker (moet op de allowlist staan).',
    {
      user_upn: z.string().describe('UPN van de ontvanger (naam@bedrijf.com)'),
      message:  z.string().min(1).describe('De berichttekst'),
    },
    async ({ user_upn, message }) => {
      try {
        // Fail-closed: lege allowlist blokkeert alles
        if (ALLOWED_UPNS.length > 0 && !ALLOWED_UPNS.includes(user_upn.toLowerCase())) {
          return { content: [{ type: 'text', text: `Geblokkeerd: ${user_upn} staat niet op de allowlist.` }], isError: true };
        }

        // Zoek user ID op via UPN
        const user = await graph('GET', `/users/${encodeURIComponent(user_upn)}?$select=id`);

        // Maak of hergebruik een 1-op-1 chat
        const chat = await graph('POST', '/chats', {
          chatType: 'oneOnOne',
          members: [
            { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${user.id}` },
          ],
        });

        await graph('POST', `/chats/${chat.id}/messages`, {
          body: { contentType: 'text', content: message },
        });
        return { content: [{ type: 'text', text: `Bericht verstuurd naar ${user_upn}.` }] };
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
  console.log(`[teams-mcp] luistert op :${PORT} (tenant: ${TENANT_ID || '(niet ingesteld)'})`);
});
