// Toggl Track MCP-server — Node.js ESM, geen externe dependencies buiten de SDK.
// Huddle injecteert TOGGL_API_TOKEN en TOGGL_WORKSPACE_ID als omgevingsvariabelen.
// Transport: SSE op GET /sse  +  POST /messages?sessionId=<id>

import { McpServer }         from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z }                 from 'zod';
import http                  from 'node:http';

const API_TOKEN    = process.env.TOGGL_API_TOKEN    || '';
const WORKSPACE_ID = process.env.TOGGL_WORKSPACE_ID || '';
const PORT         = parseInt(process.env.PORT || '8080', 10);
const MCP_BASE     = (process.env.HUDDLE_MCP_BASE || '').replace(/\/$/, '');

const BASE_URL = 'https://api.track.toggl.com/api/v9';

function auth() {
  if (!API_TOKEN) throw new Error('TOGGL_API_TOKEN is niet geconfigureerd.');
  return 'Basic ' + Buffer.from(`${API_TOKEN}:api_token`).toString('base64');
}

async function toggl(method, path, body) {
  const opts = { method, headers: { Authorization: auth(), 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) throw new Error(`Toggl ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

function nowIso() { return new Date().toISOString(); }

// ── MCP server factory ────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({ name: 'toggl', version: '1.0.0' });

  server.tool(
    'get_current_timer',
    'Haal de huidige lopende Toggl-timer op, of null als er geen loopt.',
    {},
    async () => {
      try {
        const entry = await toggl('GET', '/me/time_entries/current');
        if (!entry) return { content: [{ type: 'text', text: 'Geen lopende timer.' }] };
        return { content: [{ type: 'text', text: JSON.stringify({ id: entry.id, description: entry.description, start: entry.start }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'start_timer',
    'Start een nieuwe Toggl-timer. Stopt eventueel een lopende timer eerst.',
    {
      description: z.string().min(1).describe('Omschrijving van de taak'),
      project_id:  z.number().optional().describe('Optioneel project-ID'),
    },
    async ({ description, project_id }) => {
      try {
        if (!WORKSPACE_ID) throw new Error('TOGGL_WORKSPACE_ID is niet geconfigureerd.');
        const body = {
          description,
          workspace_id: parseInt(WORKSPACE_ID, 10),
          start: nowIso(),
          duration: -1,
          created_with: 'mcp-toggl',
          ...(project_id ? { project_id } : {}),
        };
        const entry = await toggl('POST', `/workspaces/${WORKSPACE_ID}/time_entries`, body);
        return { content: [{ type: 'text', text: `Timer gestart: "${entry.description}" (id: ${entry.id})` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'stop_timer',
    'Stop de huidige lopende Toggl-timer.',
    {},
    async () => {
      try {
        if (!WORKSPACE_ID) throw new Error('TOGGL_WORKSPACE_ID is niet geconfigureerd.');
        const current = await toggl('GET', '/me/time_entries/current');
        if (!current) return { content: [{ type: 'text', text: 'Geen lopende timer om te stoppen.' }] };
        const stopped = await toggl('PATCH', `/workspaces/${WORKSPACE_ID}/time_entries/${current.id}/stop`, {});
        const mins = Math.round((stopped.duration ?? 0) / 60);
        return { content: [{ type: 'text', text: `Timer gestopt: "${stopped.description}" (${mins} min)` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'add_time_entry',
    'Voeg handmatig een tijdblok toe aan Toggl.',
    {
      description: z.string().min(1).describe('Omschrijving'),
      start:       z.string().describe('Starttijd in ISO 8601, bijv. 2024-01-15T09:00:00+00:00'),
      stop:        z.string().describe('Eindtijd in ISO 8601'),
      project_id:  z.number().optional().describe('Optioneel project-ID'),
    },
    async ({ description, start, stop, project_id }) => {
      try {
        if (!WORKSPACE_ID) throw new Error('TOGGL_WORKSPACE_ID is niet geconfigureerd.');
        const startMs = new Date(start).getTime();
        const stopMs  = new Date(stop).getTime();
        const duration = Math.round((stopMs - startMs) / 1000);
        if (duration <= 0) throw new Error('stop moet na start liggen.');
        const body = {
          description,
          workspace_id: parseInt(WORKSPACE_ID, 10),
          start, stop, duration,
          created_with: 'mcp-toggl',
          ...(project_id ? { project_id } : {}),
        };
        const entry = await toggl('POST', `/workspaces/${WORKSPACE_ID}/time_entries`, body);
        return { content: [{ type: 'text', text: `Tijdblok toegevoegd: "${entry.description}" (${Math.round(duration / 60)} min, id: ${entry.id})` }] };
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
  console.log(`[toggl-mcp] luistert op :${PORT}`);
});
