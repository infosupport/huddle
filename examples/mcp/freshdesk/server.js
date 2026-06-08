// Freshdesk MCP-server — Node.js ESM, geen externe dependencies buiten de SDK.
// Huddle injecteert SUBDOMAIN en APIKEY als omgevingsvariabelen.
// Transport: SSE op GET /sse  +  POST /messages?sessionId=<id>

import { McpServer }       from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z }               from 'zod';
import http                from 'node:http';

const SUBDOMAIN = (process.env.SUBDOMAIN || '').trim()
  .replace(/^https?:\/\//i, '').replace(/\.freshdesk\.com\/?$/i, '');
const APIKEY = process.env.APIKEY || '';
const PORT   = parseInt(process.env.PORT || '8080', 10);

function auth() {
  return 'Basic ' + Buffer.from(APIKEY + ':X').toString('base64');
}

async function fd(path) {
  if (!SUBDOMAIN || !APIKEY) throw new Error('SUBDOMAIN en APIKEY zijn niet geconfigureerd.');
  const res = await fetch(`https://${SUBDOMAIN}.freshdesk.com/api/v2/${path}`, {
    headers: { Authorization: auth() },
  });
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fdPost(path, body) {
  if (!SUBDOMAIN || !APIKEY) throw new Error('SUBDOMAIN en APIKEY zijn niet geconfigureerd.');
  const res = await fetch(`https://${SUBDOMAIN}.freshdesk.com/api/v2/${path}`, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: ${await res.text()}`);
  return res.json();
}

const STATUS = { 2: 'Open', 3: 'In behandeling', 4: 'Opgelost', 5: 'Gesloten' };
const PRIO   = { 1: 'Laag', 2: 'Normaal', 3: 'Hoog', 4: 'Urgent' };

// ── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'freshdesk', version: '1.0.0' });

server.tool(
  'list_tickets',
  'Haal recente Freshdesk-tickets op. Geeft id, onderwerp, status, prioriteit en klantnaam terug.',
  {
    limit: z.number().min(1).max(100).default(20).describe('Aantal tickets (max 100)').optional(),
  },
  async ({ limit = 20 }) => {
    try {
      const tickets = await fd(
        `tickets?per_page=${limit}&order_by=created_at&order_type=desc&include=requester`,
      );
      if (!tickets.length) return { content: [{ type: 'text', text: 'Geen tickets gevonden.' }] };
      const text = tickets.map(t =>
        `#${t.id} — ${t.subject}\n  Status: ${STATUS[t.status] ?? t.status}  |  Prioriteit: ${PRIO[t.priority] ?? t.priority}\n  Klant: ${t.requester?.name ?? 'onbekend'}`,
      ).join('\n\n');
      return { content: [{ type: 'text', text: text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'get_ticket',
  'Haal één Freshdesk-ticket op met het volledige gesprek (omschrijving + replies).',
  {
    id: z.number().describe('Het numerieke ticket-ID'),
  },
  async ({ id }) => {
    try {
      const [ticket, conversations] = await Promise.all([
        fd(`tickets/${id}?include=requester`),
        fd(`tickets/${id}/conversations`).catch(() => []),
      ]);

      const lines = [
        `# ${ticket.subject}`,
        `**Status:** ${STATUS[ticket.status] ?? ticket.status}  |  **Prioriteit:** ${PRIO[ticket.priority] ?? ticket.priority}`,
        `**URL:** https://${SUBDOMAIN}.freshdesk.com/a/tickets/${ticket.id}`,
        `**Klant:** ${ticket.requester?.name ?? 'onbekend'}`,
        `**Aangemaakt:** ${new Date(ticket.created_at).toLocaleString('nl-NL')}`,
        '',
        '## Omschrijving',
        '',
        (ticket.description_text || '_(geen omschrijving)_').trim(),
      ];

      for (const c of conversations) {
        const type = c.private ? 'Interne noot' : (c.incoming ? 'Klant' : 'Agent');
        lines.push(
          '',
          '---',
          `### ${type} — ${new Date(c.created_at).toLocaleString('nl-NL')}`,
          '',
          (c.body_text || c.body || '_(leeg)_').trim(),
        );
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'add_private_note',
  'Voeg een interne (private) noot toe aan een Freshdesk-ticket. Zichtbaar voor agents, niet voor de klant.',
  {
    id:   z.number().describe('Het numerieke ticket-ID'),
    body: z.string().min(1).describe('De tekst van de noot'),
  },
  async ({ id, body }) => {
    try {
      const note = await fdPost(`tickets/${id}/notes`, { body, private: true });
      return { content: [{ type: 'text', text: `Noot toegevoegd (id: ${note.id}).` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
    }
  },
);

// ── SSE HTTP-server ──────────────────────────────────────────────────────────

const transports = new Map();

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/sse') {
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => transports.delete(transport.sessionId));
    await server.connect(transport);
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/messages')) {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const transport = sessionId ? transports.get(sessionId) : null;
    if (!transport) { res.writeHead(404); res.end('Sessie niet gevonden'); return; }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      req.body = body;
      await transport.handlePostMessage(req, res);
    });
    return;
  }

  res.writeHead(404);
  res.end('Niet gevonden');
});

httpServer.listen(PORT, () => {
  console.log(`[freshdesk-mcp] luistert op :${PORT} (subdomain: ${SUBDOMAIN || '(niet ingesteld)'})`);
});
