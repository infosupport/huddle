// Operator-side registration of sockets for Compose-created devcontainers.
// Kept separate from api.ts so its shipping handler can be tested without
// booting the portal, Docker integration, and WebSocket servers.

import type { FastifyInstance } from 'fastify';
import { stateEvents, notifyStateChanged } from './events';
import { registerSocketName, socketNamesReady } from './db';

const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function waitForSocketReadiness(names: string[], timeoutMs: number): Promise<boolean> {
  if (socketNamesReady(names)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ready: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stateEvents.off('changed', check);
      resolve(ready);
    };
    const check = () => { if (socketNamesReady(names)) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    stateEvents.on('changed', check);
    check();
  });
}

export function registerSocketRegistrationRoute(app: FastifyInstance): void {
  app.post<{ Body: { names?: unknown } }>('/api/docker/register-socket', async (req, reply) => {
    const names = req.body?.names;
    if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string')) {
      return reply.code(400).send({ error: 'names must be a non-empty array of strings' });
    }
    const invalid = names.filter((n) => !CONTAINER_NAME_RE.test(n));
    if (invalid.length > 0) return reply.code(400).send({ error: `invalid container name(s): ${invalid.join(', ')}` });

    for (const name of names) registerSocketName(name);
    notifyStateChanged();
    if (!(await waitForSocketReadiness(names, 6_000))) {
      return reply.code(503).send({ error: 'gateway did not confirm socket readiness within 6 seconds' });
    }
    return { registered: names, ready: true };
  });
}
