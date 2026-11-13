import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { isAuthenticated, __resetOperatorTokenCache } from '../../src/auth';

// Dependency smoke test: a real Fastify instance with an operator-token gate built on
// the production isAuthenticated() (an onRequest hook, like createApiServer installs),
// exercised through real requests. Catches a Fastify bump that changes hook or reply
// semantics. createApiServer() itself cannot be used here: it binds fixed port 3000 and
// talks to the Docker API. The gate as wired in production (allowlist included) is
// covered by the live boundary suite (test/e2e/boundary.e2e.ts, "zonder operator-token
// krijgt 401").

const TOKEN = 'smoke-test-operator-token';
let app: FastifyInstance;

beforeAll(async () => {
  process.env.HUDDLE_OPERATOR_TOKEN = TOKEN;
  __resetOperatorTokenCache();

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req, reply) => {
    if (!isAuthenticated(req.headers)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });
  app.get('/api/ping', async () => ({ pong: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.HUDDLE_OPERATOR_TOKEN;
  __resetOperatorTokenCache();
});

describe('smoke: fastify authenticated API route', () => {
  it('rejects a request without a token (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ping' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with a wrong token (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('serves the route with the operator token (200)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });
});
