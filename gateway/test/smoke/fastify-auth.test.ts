import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { operatorAuthHook, __resetOperatorTokenCache } from '../../src/auth';

// Dependency smoke test: a real Fastify instance with the production operator-token
// gate (operatorAuthHook, the same onRequest hook createApiServer installs), exercised
// through real requests. Catches a Fastify bump that changes hook or reply semantics.
// createApiServer() itself cannot be used here: it binds fixed port 3000 and talks to
// the Docker API. The live boundary suite (test/e2e/boundary.e2e.ts, "zonder
// operator-token krijgt 401") covers the gate end to end.

const TOKEN = 'smoke-test-operator-token';
let app: FastifyInstance;
let previousToken: string | undefined;

beforeAll(async () => {
  previousToken = process.env.HUDDLE_OPERATOR_TOKEN;
  process.env.HUDDLE_OPERATOR_TOKEN = TOKEN;
  __resetOperatorTokenCache();

  app = Fastify({ logger: false });
  app.addHook('onRequest', operatorAuthHook);
  app.get('/api/ping', async () => ({ pong: true }));
  app.get('/api/auth/status', async () => ({ ok: true })); // on the public allowlist
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (previousToken === undefined) delete process.env.HUDDLE_OPERATOR_TOKEN;
  else process.env.HUDDLE_OPERATOR_TOKEN = previousToken;
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

  it('lets an allowlisted route through without a token (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
  });
});
