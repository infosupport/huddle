import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ── Boundary A — rules-API mutaties (POST / PUT / DELETE) ────────────────────
// checkRule (zie rules.test.ts) dekt de leeskant. Hier testen we de schrijfkant:
// de mutatie-routes uit api.ts. createApiServer() bindt een poort en raakt Docker
// aan (listNetworks etc.), dus voor een hermetische inject-test bouwen we een
// minimale Fastify met exact dezelfde route-handlers tegen de in-memory DB.
// Geteste gedrag: status-validatie (400), 404 op onbekende id, en de side-effect
// waarbij een globale allow/deny de openstaande 'requested'-rij voor dat domein
// opruimt.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[rules-api.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;
let app: FastifyInstance;

type RuleStatus = 'requested' | 'allow' | 'deny';

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { db: database, logAudit } = await import('../src/db');
  const a = Fastify({ logger: false });

  a.post<{ Body: { domain: string; container_id?: string | null; status: RuleStatus; expires_at?: number | null } }>(
    '/api/rules',
    async (req, reply) => {
      const { domain, container_id = null, status, expires_at = null } = req.body;
      if (!domain || !['requested', 'allow', 'deny'].includes(status)) {
        return reply.code(400).send({ error: 'invalid payload' });
      }
      try {
        const info = database
          .prepare(`INSERT INTO rules (domain, container_id, status, expires_at) VALUES (?, ?, ?, ?)`)
          .run(domain, container_id, status, expires_at);
        const inserted = database.prepare(`SELECT * FROM rules WHERE id = ?`).get(info.lastInsertRowid);
        if (container_id === null && (status === 'allow' || status === 'deny')) {
          database.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested'`).run(domain);
        }
        logAudit({ containerId: container_id, domain, action: `admin:rule-${status}`, ruleId: Number(info.lastInsertRowid) });
        return inserted;
      } catch (err: any) {
        return reply.code(409).send({ error: 'duplicate', message: err.message });
      }
    }
  );

  a.put<{ Params: { id: string }; Body: { status: RuleStatus; expires_at?: number | null } }>(
    '/api/rules/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      const { status, expires_at = null } = req.body;
      if (!['requested', 'allow', 'deny'].includes(status)) {
        return reply.code(400).send({ error: 'invalid status' });
      }
      const result = database
        .prepare(`UPDATE rules SET status = ?, expires_at = ?, updated_at = unixepoch() WHERE id = ?`)
        .run(status, expires_at, id);
      if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
      const updated = database.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as any;
      if (updated.container_id === null && (status === 'allow' || status === 'deny')) {
        database.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested'`).run(updated.domain);
      }
      logAudit({ containerId: updated.container_id, domain: updated.domain, action: `admin:rule-${status}`, ruleId: id });
      return updated;
    }
  );

  a.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const rule = database.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as any;
    if (!rule) return reply.code(404).send({ error: 'not_found' });
    database.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
    logAudit({ containerId: rule.container_id, domain: rule.domain, action: 'admin:rule-delete', ruleId: id });
    return { ok: true };
  });

  await a.ready();
  return a;
}

describe.skipIf(!sqliteAvailable)('rules API mutaties', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();
    app = await buildApp();
  });
  beforeEach(() => { db.exec('DELETE FROM rules'); });

  describe('POST /api/rules', () => {
    it('maakt een nieuwe regel aan en geeft 200 met de rij', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        payload: { domain: 'example.com', container_id: 'c1', status: 'allow' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.domain).toBe('example.com');
      expect(body.status).toBe('allow');
      expect(body.container_id).toBe('c1');
    });

    it('geeft 400 bij een ongeldige status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        payload: { domain: 'example.com', status: 'maybe' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('geeft 400 bij een ontbrekend domein', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        payload: { status: 'allow' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('een globale allow ruimt openstaande per-container requested-rijen op voor hetzelfde domein', async () => {
      // Twee containers hadden 'seed.test' aangevraagd; een globale allow lost
      // dat in één keer op en verwijdert die requested-rijen.
      db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('seed.test', 'c1', 'requested')`).run();
      db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('seed.test', 'c2', 'requested')`).run();
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        payload: { domain: 'seed.test', container_id: null, status: 'allow' },
      });
      expect(res.statusCode).toBe(200);
      const remaining = db.prepare(`SELECT status FROM rules WHERE domain = 'seed.test'`).all() as any[];
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe('allow');
    });

    it('geeft 409 bij een duplicate (domain+container uniek)', async () => {
      await app.inject({ method: 'POST', url: '/api/rules', payload: { domain: 'dup.test', container_id: 'c1', status: 'allow' } });
      const res = await app.inject({ method: 'POST', url: '/api/rules', payload: { domain: 'dup.test', container_id: 'c1', status: 'deny' } });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('PUT /api/rules/:id', () => {
    function insertRule(domain: string, container: string | null, status: RuleStatus): number {
      const info = db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, ?, ?)`).run(domain, container, status);
      return Number(info.lastInsertRowid);
    }

    it('wijzigt de status naar allow', async () => {
      const id = insertRule('toggle.test', 'c1', 'requested');
      const res = await app.inject({ method: 'PUT', url: `/api/rules/${id}`, payload: { status: 'allow' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('allow');
      const row = db.prepare(`SELECT status FROM rules WHERE id = ?`).get(id) as any;
      expect(row.status).toBe('allow');
    });

    it('wijzigt de status naar deny', async () => {
      const id = insertRule('toggle2.test', 'c1', 'requested');
      const res = await app.inject({ method: 'PUT', url: `/api/rules/${id}`, payload: { status: 'deny' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('deny');
    });

    it('zet een temp-allow met expires_at', async () => {
      const id = insertRule('temp.test', 'c1', 'requested');
      const res = await app.inject({ method: 'PUT', url: `/api/rules/${id}`, payload: { status: 'allow', expires_at: 1893456000 } });
      expect(res.statusCode).toBe(200);
      const row = db.prepare(`SELECT expires_at FROM rules WHERE id = ?`).get(id) as any;
      expect(row.expires_at).toBe(1893456000);
    });

    it('geeft 400 bij een ongeldige status', async () => {
      const id = insertRule('bad.test', 'c1', 'requested');
      const res = await app.inject({ method: 'PUT', url: `/api/rules/${id}`, payload: { status: 'nonsense' } });
      expect(res.statusCode).toBe(400);
    });

    it('geeft 404 voor een onbekende id', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/rules/999999', payload: { status: 'allow' } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/rules/:id', () => {
    it('verwijdert een bestaande regel', async () => {
      const info = db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('del.test', 'c1', 'allow')`).run();
      const id = Number(info.lastInsertRowid);
      const res = await app.inject({ method: 'DELETE', url: `/api/rules/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id)).toBeUndefined();
    });

    it('geeft 404 voor een onbekende id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/rules/999999' });
      expect(res.statusCode).toBe(404);
    });
  });
});
