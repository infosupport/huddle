import type { FastifyInstance } from 'fastify';
import { storeTokenExchange, revokeTokenExchange } from './token-exchange';
import { logAudit } from './db';

// Host-side registration for the token exchange. The operator (in practice the
// CLI's `huddle update-agent`) hands a Claude API key or OAuth token to the
// gateway and gets a placeholder back; only the placeholder enters the
// container. The proxy swaps it back on api.anthropic.com for this container
// only (proxy.ts, resolveToken). Behind the operator auth hook like every other
// /api/* route.

// Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]*
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
// The secret ends up in an HTTP header: printable ASCII, no spaces or CR/LF.
const SECRET = /^[\x21-\x7e]{1,4096}$/;

export function registerTokenExchangeRoutes(app: FastifyInstance): void {
  app.post<{ Params: { name: string }; Body: { secret?: unknown } }>(
    '/api/docker/containers/:name/token',
    async (req, reply) => {
      const { name } = req.params;
      const secret = req.body?.secret;
      if (!CONTAINER_NAME.test(name)) return reply.code(400).send({ error: 'invalid container name' });
      if (typeof secret !== 'string' || !SECRET.test(secret)) {
        return reply.code(400).send({ error: 'secret must be a non-empty token without whitespace' });
      }
      const placeholder = storeTokenExchange(name, secret, 'host');
      // Never log the secret or the placeholder.
      logAudit({ containerId: name, domain: 'api.anthropic.com', action: 'admin:token-register' });
      return { placeholder };
    }
  );

  app.delete<{ Params: { name: string } }>(
    '/api/docker/containers/:name/token',
    async (req, reply) => {
      const { name } = req.params;
      if (!CONTAINER_NAME.test(name)) return reply.code(400).send({ error: 'invalid container name' });
      revokeTokenExchange(name, 'host');
      logAudit({ containerId: name, domain: 'api.anthropic.com', action: 'admin:token-revoke' });
      return { ok: true };
    }
  );
}
