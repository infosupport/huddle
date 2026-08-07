import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ── Rules export/import (#69) ────────────────────────────────────────────────
// Same hermetic approach as rules-api.test.ts: createApiServer() binds a
// port and touches Docker, so we build a minimal Fastify with exactly the
// export/import handlers from api.ts against the in-memory DB. Tested: the export
// envelope, the merge round-trip (export → wipe → import), replace scope, and
// fail-closed validation (400) on invalid payloads.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[rules-export-import.test] SKIPPED — better-sqlite3 binding not usable: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;
let app: FastifyInstance;

type RuleStatus = 'requested' | 'allow' | 'deny';

interface ShareableRule {
  domain: string;
  container_id: string | null;
  status: RuleStatus;
  path_pattern: string | null;
  path_mode: number;
  expires_at: number | null;
}

const RULE_IMPORT_FIELDS = new Set(['domain', 'container_id', 'status', 'path_pattern', 'path_mode', 'expires_at']);

function validateImportRule(raw: unknown): ShareableRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('rule must be an object');
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !RULE_IMPORT_FIELDS.has(k));
  if (unknown.length > 0) throw new Error(`unknown field(s): ${unknown.join(', ')}`);
  if (typeof r.domain !== 'string' || !r.domain) throw new Error('domain must be a non-empty string');
  if (r.status !== 'requested' && r.status !== 'allow' && r.status !== 'deny') throw new Error('invalid status');
  const container_id = r.container_id === undefined || r.container_id === null ? null : r.container_id;
  if (container_id !== null && typeof container_id !== 'string') throw new Error('container_id must be a string or null');
  const path_pattern = r.path_pattern === undefined || r.path_pattern === null ? null : r.path_pattern;
  if (path_pattern !== null && typeof path_pattern !== 'string') throw new Error('path_pattern must be a string or null');
  const path_mode = r.path_mode === undefined || r.path_mode === null ? 0 : r.path_mode;
  if (path_mode !== 0 && path_mode !== 1) throw new Error('path_mode must be 0 or 1');
  const expires_at = r.expires_at === undefined || r.expires_at === null ? null : r.expires_at;
  if (expires_at !== null && (typeof expires_at !== 'number' || !Number.isFinite(expires_at))) {
    throw new Error('expires_at must be a number or null');
  }
  return { domain: r.domain, container_id, status: r.status, path_pattern, path_mode, expires_at };
}

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { db: database } = await import('../src/db');
  const a = Fastify({ logger: false });

  a.get<{ Querystring: { container?: string } }>('/api/rules/export', async (req) => {
    const { container } = req.query;
    const where: string[] = [];
    const params: any[] = [];
    if (container) {
      if (container === '__global__') where.push('container_id IS NULL');
      else { where.push('container_id = ?'); params.push(container); }
    }
    const sql =
      `SELECT domain, container_id, status, path_pattern, path_mode, expires_at FROM rules` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY domain COLLATE NOCASE, COALESCE(container_id, ''), COALESCE(path_pattern, '')`;
    const rules = database.prepare(sql).all(...params) as ShareableRule[];
    return { version: 1, exported_at: Math.floor(Date.now() / 1000), rules };
  });

  a.post<{
    Querystring: { container?: string };
    Body: { mode?: string; rules?: unknown };
  }>('/api/rules/import', async (req, reply) => {
    const body = req.body ?? {};
    const mode = body.mode ?? 'merge';
    if (mode !== 'merge' && mode !== 'replace') return reply.code(400).send({ error: 'bad mode' });
    if (!Array.isArray(body.rules)) return reply.code(400).send({ error: 'rules must be an array' });

    const { container } = req.query;
    const scopeOverride = container === undefined ? undefined : container === '__global__' ? null : container;

    let parsed: ShareableRule[];
    try {
      parsed = body.rules.map(validateImportRule);
    } catch (err: any) {
      return reply.code(400).send({ error: 'invalid rule', message: err.message });
    }
    const effective = scopeOverride === undefined ? parsed : parsed.map((r) => ({ ...r, container_id: scopeOverride }));

    const findExisting = database.prepare(
      `SELECT id FROM rules WHERE domain = ? COLLATE NOCASE
         AND COALESCE(container_id, '') = COALESCE(?, '')
         AND COALESCE(path_pattern, '') = COALESCE(?, '')`
    );
    const insertRule = database.prepare(
      `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern, path_mode) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const updateRule = database.prepare(
      `UPDATE rules SET status = ?, expires_at = ?, path_mode = ?, updated_at = unixepoch() WHERE id = ?`
    );

    let imported = 0, updated = 0, skipped = 0;
    const runImport = database.transaction(() => {
      if (mode === 'replace') {
        const scopes = new Set(effective.map((r) => r.container_id));
        for (const s of scopes) {
          if (s === null) database.prepare(`DELETE FROM rules WHERE container_id IS NULL`).run();
          else database.prepare(`DELETE FROM rules WHERE container_id = ?`).run(s);
        }
      }
      const seen = new Set<string>();
      for (const r of effective) {
        const key = `${r.domain.toLowerCase()} ${r.container_id ?? ''} ${r.path_pattern ?? ''}`;
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);
        const existing = findExisting.get(r.domain, r.container_id, r.path_pattern) as { id: number } | undefined;
        if (existing) { updateRule.run(r.status, r.expires_at, r.path_mode, existing.id); updated++; }
        else { insertRule.run(r.domain, r.container_id, r.status, r.expires_at, r.path_pattern, r.path_mode); imported++; }
      }
    });
    try { runImport(); } catch (err: any) { return reply.code(409).send({ error: 'import failed', message: err.message }); }
    return { imported, updated, skipped };
  });

  await a.ready();
  return a;
}

describe.skipIf(!sqliteAvailable)('rules export/import', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    dbMod.initDb();
    app = await buildApp();
  });
  beforeEach(() => { db.exec('DELETE FROM rules'); });

  function seed(domain: string, container: string | null, status: RuleStatus, path: string | null = null): void {
    db.prepare(`INSERT INTO rules (domain, container_id, status, path_pattern) VALUES (?, ?, ?, ?)`)
      .run(domain, container, status, path);
  }

  describe('GET /api/rules/export', () => {
    it('returns a versioned envelope with only shareable fields', async () => {
      seed('a.example.com', null, 'allow');
      seed('b.example.com', 'c1', 'deny');
      const res = await app.inject({ method: 'GET', url: '/api/rules/export' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.version).toBe(1);
      expect(typeof body.exported_at).toBe('number');
      expect(body.rules).toHaveLength(2);
      // No volatile fields leak along
      const keys = Object.keys(body.rules[0]).sort();
      expect(keys).toEqual(['container_id', 'domain', 'expires_at', 'path_mode', 'path_pattern', 'status']);
    });

    it('filters by container scope', async () => {
      seed('g.example.com', null, 'allow');
      seed('c.example.com', 'c1', 'allow');
      const global = (await app.inject({ method: 'GET', url: '/api/rules/export?container=__global__' })).json();
      expect(global.rules).toHaveLength(1);
      expect(global.rules[0].domain).toBe('g.example.com');
      const c1 = (await app.inject({ method: 'GET', url: '/api/rules/export?container=c1' })).json();
      expect(c1.rules).toHaveLength(1);
      expect(c1.rules[0].container_id).toBe('c1');
    });
  });

  describe('POST /api/rules/import', () => {
    it('merge round-trip: export → wipe → import restores the rules', async () => {
      seed('one.example.com', null, 'allow');
      seed('two.example.com', 'c1', 'deny');
      const doc = (await app.inject({ method: 'GET', url: '/api/rules/export' })).json();
      db.exec('DELETE FROM rules');

      const res = await app.inject({ method: 'POST', url: '/api/rules/import', payload: { mode: 'merge', rules: doc.rules } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ imported: 2, updated: 0, skipped: 0 });
      const rows = db.prepare(`SELECT domain, status FROM rules ORDER BY domain`).all() as any[];
      expect(rows.map((r) => r.domain)).toEqual(['one.example.com', 'two.example.com']);
    });

    it('merge upsert: an existing unique key is updated instead of duplicated', async () => {
      seed('dup.example.com', null, 'deny');
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules/import',
        payload: { mode: 'merge', rules: [{ domain: 'dup.example.com', container_id: null, status: 'allow' }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ imported: 0, updated: 1, skipped: 0 });
      const rows = db.prepare(`SELECT status FROM rules WHERE domain = 'dup.example.com'`).all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('allow');
    });

    it('in-batch duplicate counts as skipped', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules/import',
        payload: {
          mode: 'merge',
          rules: [
            { domain: 'x.example.com', status: 'allow' },
            { domain: 'x.example.com', status: 'deny' },
          ],
        },
      });
      expect(res.json()).toEqual({ imported: 1, updated: 0, skipped: 1 });
    });

    it('replace only replaces the imported scope', async () => {
      seed('old-global.example.com', null, 'allow');
      seed('keep-c1.example.com', 'c1', 'allow');
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules/import',
        payload: { mode: 'replace', rules: [{ domain: 'new-global.example.com', container_id: null, status: 'deny' }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ imported: 1, updated: 0, skipped: 0 });
      // Global scope replaced, container scope left untouched
      const globals = db.prepare(`SELECT domain FROM rules WHERE container_id IS NULL`).all() as any[];
      expect(globals.map((r) => r.domain)).toEqual(['new-global.example.com']);
      const c1 = db.prepare(`SELECT domain FROM rules WHERE container_id = 'c1'`).all() as any[];
      expect(c1.map((r) => r.domain)).toEqual(['keep-c1.example.com']);
    });

    it('container override remaps all rules to the given scope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules/import?container=c2',
        payload: { mode: 'merge', rules: [{ domain: 'remap.example.com', container_id: null, status: 'allow' }] },
      });
      expect(res.statusCode).toBe(200);
      const row = db.prepare(`SELECT container_id FROM rules WHERE domain = 'remap.example.com'`).get() as any;
      expect(row.container_id).toBe('c2');
    });

    it('400 on an unknown field (fail-closed)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules/import',
        payload: { mode: 'merge', rules: [{ domain: 'x.example.com', status: 'allow', evil: 1 }] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 on an invalid status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules/import',
        payload: { mode: 'merge', rules: [{ domain: 'x.example.com', status: 'maybe' }] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 on an empty/missing domain', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules/import',
        payload: { mode: 'merge', rules: [{ domain: '', status: 'allow' }] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 when rules is not an array', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/rules/import', payload: { mode: 'merge', rules: 'nope' } });
      expect(res.statusCode).toBe(400);
    });

    it('400 on an invalid mode', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/rules/import', payload: { mode: 'wipe', rules: [] } });
      expect(res.statusCode).toBe(400);
    });
  });
});
