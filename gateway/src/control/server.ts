// Huddle Node's control listener.
//
// A SECOND HTTP server, on its own port, and that is the point.
//
// The portal and the REST API bind loopback on the host: Huddle Node execs into
// containers, runs terminals and rewrites firewall policy, and the operator
// token is the only thing between that and the network. On Linux, though, a
// container cannot reach the host's loopback — `host.docker.internal` resolves
// to the bridge address there — so the gateway needs Node to listen on an
// address that is not 127.0.0.1.
//
// Mounting /control on the portal and widening THAT to the bridge would put the
// operator token's entire surface on the default Docker network, where every
// container on the machine could knock on it. So only the control channel
// moves: a listener that serves four endpoints, accepts the gateway token and
// nothing else, and 404s everything that is not /control/*. Devcontainers cannot
// reach even this — their network is `--internal` and has no route off itself.

import Fastify, { type FastifyInstance } from 'fastify';
import { isGatewayAuthenticated } from '../auth';
import { runtimeEnv } from '../runtime-env';
import { isControlPath } from './http';
import { registerControlRoutes } from './routes';
import { attachSocketRelay } from './socket-relay-server';

// A report carries audit rows, and an audit row carries up to four 20 KB
// header/body fields (CAP in proxy.ts). Fastify's 1 MB default would reject a
// perfectly ordinary batch; the client caps its own queue well below this.
const BODY_LIMIT = 64 * 1024 * 1024;

export async function createControlServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT });

  app.addHook('onRequest', async (req, reply) => {
    // Anything outside the control channel does not exist here. This server has
    // no static assets and no /api — a request that reached it by mistake
    // should learn nothing about what else Huddle runs.
    const pathOnly = (req.raw.url ?? '').split('?')[0];
    if (!isControlPath(pathOnly)) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    // Gateway token only, Bearer only. The operator token does NOT open this —
    // see auth.ts for why the two are kept apart.
    if (!isGatewayAuthenticated(req.headers)) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
  });

  registerControlRoutes(app);

  app.setErrorHandler((err: Error, _req, reply) => {
    console.error('[control] request failed:', err.message);
    if (!reply.sent) reply.code(500).send({ error: err.message });
  });

  // Before listen(), so the first connection cannot arrive without a handler:
  // an HTTP server with no `upgrade` listener destroys the socket outright.
  attachSocketRelay(app.server);

  const address = await app.listen({ port: runtimeEnv.controlPort, host: runtimeEnv.controlBindHost });
  console.log(`[control] listening on ${address}`);
  if (runtimeEnv.controlBindHost !== '127.0.0.1' && runtimeEnv.controlBindHost !== 'localhost') {
    console.log(`[control] bound beyond loopback (${runtimeEnv.controlBindHost}) so the gateway container can reach it`);
  }
  return app;
}
