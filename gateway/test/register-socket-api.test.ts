import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { notifyStateChanged } from '../src/events';

// The write half of blocker 15 (docs/ADR-huddle-node-split.md): the route
// `huddle migrate --docker-socket` calls to tell Node about a container it is
// about to start with `docker compose up`, ahead of that container existing.
// api.ts touches Docker on import (see rules-api.test.ts's note), so this
// rebuilds the one handler against the real, in-memory db — same pattern.

let db: typeof import('../src/db').db;
let listRegisteredSocketNames: typeof import('../src/db').listRegisteredSocketNames;
let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { registerSocketRegistrationRoute } = await import('../src/socket-registration');
  const a = Fastify({ logger: false });
  registerSocketRegistrationRoute(a);
  return a;
}

beforeAll(async () => {
  const dbMod = await import('../src/db');
  db = dbMod.db;
  listRegisteredSocketNames = dbMod.listRegisteredSocketNames;
  dbMod.initDb();
  app = await buildApp();
});

beforeEach(() => { db.exec('DELETE FROM socket_registrations'); });

async function injectReady(names: string[]) {
  const before = new Map((db.prepare(`SELECT name, revision FROM socket_registrations WHERE name IN (${names.map(() => '?').join(',')})`).all(...names) as { name: string; revision: string }[]).map((r) => [r.name, r.revision]));
  const pending = app.inject({ method: 'POST', url: '/api/docker/register-socket', payload: { names } });
  for (let i = 0; i < 50; i++) {
    const rows = db.prepare(`SELECT name, revision FROM socket_registrations WHERE name IN (${names.map(() => '?').join(',')})`).all(...names) as { name: string; revision: string }[];
    if (rows.length === names.length && rows.every((r) => before.get(r.name) !== r.revision)) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  for (const name of names) db.prepare('UPDATE socket_registrations SET ready_at = unixepoch() WHERE name = ?').run(name);
  notifyStateChanged();
  return pending;
}

describe('POST /api/docker/register-socket', () => {
  it('registers every name and answers with them', async () => {
    const res = await injectReady(['compose-api', 'compose-db']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ registered: ['compose-api', 'compose-db'], ready: true });
    expect(listRegisteredSocketNames()).toEqual(['compose-api', 'compose-db']);
  });

  it('is idempotent — re-registering the same name does not duplicate it', async () => {
    await injectReady(['compose-api']);
    await injectReady(['compose-api']);
    expect(listRegisteredSocketNames()).toEqual(['compose-api']);
  });

  it('rejects an empty or missing names array', async () => {
    for (const payload of [{}, { names: [] }, { names: 'compose-api' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/docker/register-socket', payload });
      expect(res.statusCode).toBe(400);
    }
  });

  // The name reaches path.join() in the gateway's relay (socket-relay.ts) and
  // Node's own registry — a `..` or leading `/` must not get anywhere near either.
  it('rejects a name outside Docker\'s naming grammar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/docker/register-socket',
      payload: { names: ['../etc/passwd'] },
    });
    expect(res.statusCode).toBe(400);
    expect(listRegisteredSocketNames()).toEqual([]);
  });

  it('does not answer successfully before gateway readiness, then completes on acknowledgement', async () => {
    const pending = app.inject({ method: 'POST', url: '/api/docker/register-socket', payload: { names: ['compose-api'] } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    db.prepare(`UPDATE socket_registrations SET ready_at = unixepoch() WHERE name = 'compose-api'`).run();
    notifyStateChanged();
    expect((await pending).json()).toEqual({ registered: ['compose-api'], ready: true });
  });
});
