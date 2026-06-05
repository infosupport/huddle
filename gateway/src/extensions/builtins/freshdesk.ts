import type { HuddleExtension, ExtensionContext } from '../types';
import { getExtValue, setExtValue } from '../../db';

const ID = 'freshdesk';

interface FreshdeskTicket {
  id: number;
  subject: string;
  status: number;
  priority: number;
}

function getConfig(): { subdomain?: string; apiKey?: string } {
  return {
    subdomain: getExtValue(ID, 'subdomain'),
    apiKey: getExtValue(ID, 'apiKey'),
  };
}

export const freshdeskExtension: HuddleExtension = {
  id: ID,
  name: 'Freshdesk',
  icon: 'bug',
  settings: [
    { key: 'subdomain', label: 'Subdomein' },
    { key: 'apiKey', label: 'API-sleutel', secret: true },
  ],

  register(ctx: ExtensionContext): void {
    const { app, log } = ctx;

    app.get('/api/ext/freshdesk/settings', async () => {
      const { subdomain, apiKey } = getConfig();
      return { subdomain: subdomain ?? '', hasApiKey: Boolean(apiKey) };
    });

    app.post<{ Body: { subdomain?: string; apiKey?: string } }>(
      '/api/ext/freshdesk/settings',
      async (req) => {
        const { subdomain, apiKey } = req.body ?? {};
        if (subdomain !== undefined) setExtValue(ID, 'subdomain', subdomain.trim());
        // Een leeg apiKey-veld laat de bestaande sleutel ongemoeid, zodat de
        // operator instellingen kan opslaan zonder de secret opnieuw in te typen.
        if (apiKey) setExtValue(ID, 'apiKey', apiKey);
        return { ok: true };
      },
    );

    app.get('/api/ext/freshdesk/tickets', async (_req, reply) => {
      const { subdomain, apiKey } = getConfig();
      if (!subdomain || !apiKey) {
        return reply.code(422).send({
          error: 'not_configured',
          message: 'Configureer eerst subdomein en API-sleutel bij de extensie-instellingen.',
        });
      }
      const url = `https://${subdomain}.freshdesk.com/api/v2/tickets`;
      const auth = Buffer.from(`${apiKey}:X`).toString('base64');
      try {
        const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
        if (!res.ok) {
          return reply.code(502).send({
            error: 'freshdesk_error',
            message: `Freshdesk gaf status ${res.status} terug.`,
          });
        }
        const tickets = (await res.json()) as FreshdeskTicket[];
        return tickets.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          priority: t.priority,
        }));
      } catch (err: any) {
        return reply.code(502).send({
          error: 'network',
          message: `Kan ${subdomain}.freshdesk.com niet bereiken — sta dit domein toe in de Huddle-firewall.`,
          detail: err?.message,
        });
      }
    });

    app.post<{ Body: { ticketId: number; imageName: string; ideName?: string } }>(
      '/api/ext/freshdesk/containers',
      async (req, reply) => {
        const { ticketId, imageName, ideName } = req.body ?? ({} as any);
        if (!ticketId || !imageName) {
          return reply.code(400).send({ error: 'ticketId and imageName required' });
        }
        const containerName = `devcontainer-freshdesk-${ticketId}`;
        const res = await app.inject({
          method: 'POST',
          url: '/api/docker/start',
          payload: { imageName, containerName, ideName, empty: true },
        });
        if (res.statusCode >= 400) {
          return reply.code(res.statusCode).send(res.json());
        }
        log(`started container for ticket ${ticketId}`);
        return res.json();
      },
    );
  },
};
