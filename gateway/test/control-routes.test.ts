import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ── The control channel end to end ──────────────────────────────────────────
//
// control-http.test.ts covers the path predicate and version comparison as pure
// functions. This asserts the assembled thing: that the guard actually refuses
// an unauthenticated caller, that the operator token is not a way in, and that
// the policy feed serves what decide() needs with working ETag semantics.
//
// createApiServer() binds a port and reaches for Docker, so — following
// rules-api.test.ts — we mount the REAL guard and the REAL registerControlRoutes
// on a bare Fastify. Only the four lines of hook wiring are restated here; the
// predicate, the auth check and the handlers are the shipping ones.
//
// better-sqlite3 is a native module; without a usable binding (nodejs.org
// blocked → node-gyp cannot fetch headers) this suite skips, as the other
// DB-backed suites do.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[control-routes.test] SKIPPED — better-sqlite3 unusable: ${(e as Error).message}`);
}

const GW_TOKEN = 'gateway-token-for-tests';
const OP_TOKEN = 'operator-token-for-tests';

let db: typeof import('../src/db').db;
let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { isGatewayAuthenticated } = await import('../src/auth');
  const { isControlPath } = await import('../src/control/http');
  const { registerControlRoutes } = await import('../src/control/routes');

  const a = Fastify({ logger: false });
  a.addHook('onRequest', async (req, reply) => {
    const pathOnly = (req.url ?? '').split('?')[0];
    if (isControlPath(pathOnly)) {
      if (!isGatewayAuthenticated(req.headers)) {
        reply.code(401).send({ error: 'unauthorized', reason: 'gateway authentication required' });
      }
      return;
    }
  });
  registerControlRoutes(a);
  return a;
}

const asGateway = { authorization: `Bearer ${GW_TOKEN}` };

describe.skipIf(!sqliteAvailable)('control channel', () => {
  beforeAll(async () => {
    process.env.HUDDLE_GATEWAY_TOKEN = GW_TOKEN;
    process.env.HUDDLE_OPERATOR_TOKEN = OP_TOKEN;
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();
    app = await buildApp();
  });
  afterAll(() => {
    delete process.env.HUDDLE_GATEWAY_TOKEN;
    delete process.env.HUDDLE_OPERATOR_TOKEN;
  });
  beforeEach(() => { db.exec('DELETE FROM rules'); db.exec('DELETE FROM containers'); });

  describe('authentication', () => {
    it.each(['/control/health', '/control/policy', '/control/containers'])(
      'refuses %s without a token',
      async (url) => {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(401);
      },
    );

    it('refuses the OPERATOR token — the two are not interchangeable', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/control/policy',
        headers: { authorization: `Bearer ${OP_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('does not accept the gateway token in a cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/control/policy',
        headers: { cookie: `huddle_session=${GW_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('admits the gateway token', async () => {
      const res = await app.inject({ method: 'GET', url: '/control/health', headers: asGateway });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, role: 'node' });
    });

    it('refuses a query string used to dress the path up as something else', async () => {
      const res = await app.inject({ method: 'GET', url: '/control/policy?x=/api/rules' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /control/policy', () => {
    it('serves the rules the gateway decides from', async () => {
      db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, ?, ?)`)
        .run('example.com', null, 'allow');
      const res = await app.inject({ method: 'GET', url: '/control/policy', headers: asGateway });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rules).toHaveLength(1);
      expect(body.rules[0]).toMatchObject({ domain: 'example.com', status: 'allow', container_id: null });
      expect(body.version).toMatch(/^[0-9a-f]{32}$/);
    });

    it('reports which containers are airlocked', async () => {
      db.prepare(`INSERT INTO containers (name, airlocked) VALUES (?, 1)`).run('dc-locked');
      db.prepare(`INSERT INTO containers (name, airlocked) VALUES (?, 0)`).run('dc-open');
      const body = (await app.inject({ method: 'GET', url: '/control/policy', headers: asGateway })).json();
      expect(body.airlocked).toEqual(['dc-locked']);
    });

    it('answers a matching If-None-Match with 304 and no body', async () => {
      const first = await app.inject({ method: 'GET', url: '/control/policy', headers: asGateway });
      const etag = first.headers.etag as string;
      expect(etag).toBe(`"${first.json().version}"`);

      const second = await app.inject({
        method: 'GET',
        url: '/control/policy',
        headers: { ...asGateway, 'if-none-match': etag },
      });
      expect(second.statusCode).toBe(304);
      expect(second.body).toBe('');
    });

    it('serves a fresh version once a rule changes', async () => {
      const before = (await app.inject({ method: 'GET', url: '/control/policy', headers: asGateway })).json().version;
      db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, ?, ?)`)
        .run('new.example', null, 'deny');
      const after = await app.inject({
        method: 'GET',
        url: '/control/policy',
        headers: { ...asGateway, 'if-none-match': `"${before}"` },
      });
      // The gateway must not be told "unchanged" for policy that did change —
      // that is the failure mode where a revoked rule keeps letting traffic out.
      expect(after.statusCode).toBe(200);
      expect(after.json().version).not.toBe(before);
    });

    it('is stable across repeated reads of unchanged policy', async () => {
      const a = (await app.inject({ method: 'GET', url: '/control/policy', headers: asGateway })).json().version;
      const b = (await app.inject({ method: 'GET', url: '/control/policy', headers: asGateway })).json().version;
      expect(a).toBe(b);
    });
  });
});
