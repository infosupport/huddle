import path from 'path';
import fs from 'fs';
import Fastify, { FastifyInstance } from 'fastify';
import { db, getAllGrants, setGrant, deleteGrant } from './db';
import {
  listDevcontainers,
  inspectContainer,
  commitContainer,
  listSnapshotImages,
  createAndStartContainer,
  getBaseImageName,
  type StartParams,
} from './docker';

const API_PORT = 3000;
const UI_DIR = path.join(__dirname, 'ui');

type RuleStatus = 'requested' | 'allow' | 'deny';

interface Rule {
  id: number;
  domain: string;
  container_id: string | null;
  status: RuleStatus;
  created_at: number;
  updated_at: number;
  last_seen: number;
  request_count: number;
}

function serveStatic(file: string, type: string) {
  return async (_req: any, reply: any) => {
    try {
      const content = fs.readFileSync(path.join(UI_DIR, file));
      reply.header('content-type', type).send(content);
    } catch {
      reply.code(404).send({ error: 'not_found' });
    }
  };
}

export function createApiServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/', serveStatic('index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', serveStatic('app.js', 'application/javascript; charset=utf-8'));
  app.get('/style.css', serveStatic('style.css', 'text/css; charset=utf-8'));
  app.get<{ Params: { file: string } }>('/assets/:file', async (req, reply) => {
    const file = req.params.file;
    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      return reply.code(400).send({ error: 'invalid_file' });
    }
    try {
      const content = fs.readFileSync(path.join(UI_DIR, 'assets', file));
      const ext = file.split('.').pop() ?? '';
      const types: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        svg: 'image/svg+xml',
        json: 'application/json',
      };
      reply.header('content-type', types[ext] ?? 'application/octet-stream').send(content);
    } catch {
      reply.code(404).send({ error: 'not_found' });
    }
  });

  app.get<{ Querystring: { status?: string; container?: string } }>(
    '/api/rules',
    async (req) => {
      const { status, container } = req.query;
      const where: string[] = [];
      const params: any[] = [];

      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      if (container) {
        if (container === '__global__') {
          where.push('container_id IS NULL');
        } else {
          where.push('container_id = ?');
          params.push(container);
        }
      }

      const sql =
        `SELECT * FROM rules` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY last_seen DESC`;

      return db.prepare(sql).all(...params) as Rule[];
    }
  );

  app.put<{ Params: { id: string }; Body: { status: RuleStatus } }>(
    '/api/rules/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      const { status } = req.body;
      if (!['requested', 'allow', 'deny'].includes(status)) {
        return reply.code(400).send({ error: 'invalid status' });
      }
      const result = db
        .prepare(`UPDATE rules SET status = ?, updated_at = unixepoch() WHERE id = ?`)
        .run(status, id);
      if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
      const updated = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule;
      if (updated.container_id === null && (status === 'allow' || status === 'deny')) {
        db.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested'`).run(updated.domain);
      }
      return updated;
    }
  );

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const result = db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
    if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post<{
    Body: { domain: string; container_id?: string | null; status: RuleStatus };
  }>('/api/rules', async (req, reply) => {
    const { domain, container_id = null, status } = req.body;
    if (!domain || !['requested', 'allow', 'deny'].includes(status)) {
      return reply.code(400).send({ error: 'invalid payload' });
    }
    try {
      const info = db
        .prepare(
          `INSERT INTO rules (domain, container_id, status) VALUES (?, ?, ?)`
        )
        .run(domain, container_id, status);
      const inserted = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(info.lastInsertRowid) as Rule;
      if (container_id === null && (status === 'allow' || status === 'deny')) {
        db.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested'`).run(domain);
      }
      return inserted;
    } catch (err: any) {
      return reply.code(409).send({ error: 'duplicate', message: err.message });
    }
  });

  app.get('/api/containers', async () => {
    const rows = db
      .prepare(
        `SELECT DISTINCT container_id FROM rules WHERE container_id IS NOT NULL ORDER BY container_id`
      )
      .all() as { container_id: string }[];
    return rows.map((r) => r.container_id);
  });

  // ── Docker management ──────────────────────────────────────────────────────

  app.get('/api/docker/containers', async () => {
    const [containers, requestedCounts] = await Promise.all([
      listDevcontainers(),
      Promise.resolve(
        db
          .prepare(
            `SELECT container_id, COUNT(*) as cnt FROM rules WHERE status = 'requested' AND container_id IS NOT NULL GROUP BY container_id`
          )
          .all() as { container_id: string; cnt: number }[]
      ),
    ]);
    const countMap = new Map(requestedCounts.map((r) => [r.container_id, r.cnt]));
    return containers.map((c) => ({ ...c, requestedCount: countMap.get(c.name) ?? 0 }));
  });

  app.get<{ Params: { name: string } }>('/api/docker/containers/:name', async (req, reply) => {
    try {
      const [inspect, rules] = await Promise.all([
        inspectContainer(req.params.name),
        Promise.resolve(
          db
            .prepare(`SELECT * FROM rules WHERE container_id = ? ORDER BY status, domain`)
            .all(req.params.name) as Rule[]
        ),
      ]);
      return { inspect, rules };
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  app.post<{ Params: { name: string }; Body: { imageName: string } }>(
    '/api/docker/containers/:name/snapshot',
    async (req, reply) => {
      const { imageName } = req.body;
      if (!imageName) return reply.code(400).send({ error: 'imageName required' });
      try {
        const inspect = await inspectContainer(req.params.name);
        const imageId = await commitContainer(inspect.Id, imageName);
        return { imageId };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  app.get('/api/docker/images', async () => {
    return listSnapshotImages();
  });

  app.get('/api/docker/base-image', async () => {
    return { imageName: getBaseImageName() };
  });

  app.post<{ Body: { imageName: string; workspaceDir: string; containerName: string; ideName?: string } }>(
    '/api/docker/start',
    async (req, reply) => {
      const { imageName, workspaceDir, containerName, ideName } = req.body;
      if (!imageName || !workspaceDir || !containerName) {
        return reply.code(400).send({ error: 'imageName, workspaceDir and containerName required' });
      }
      const fwd = workspaceDir.replace(/\\/g, '/').replace(/\/$/, '');
      const leaf = fwd.split('/').pop() ?? containerName;
      const ide: 'intellij' | 'rider' = ideName === 'rider' ? 'rider' : 'intellij';
      const params: StartParams = {
        imageName,
        workspaceDir: fwd,
        containerName,
        containerWorkspace: `/workspaces/${leaf}`,
        presentableName: leaf,
        ideName: ide,
      };
      try {
        const id = await createAndStartContainer(params);
        return { id, containerName };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── Docker access grants (persisted in SQLite) ────────────────────────────

  app.get('/api/authz/grants', async () => getAllGrants());

  app.put<{ Params: { container: string }; Body: { minutes: number } }>(
    '/api/authz/grants/:container',
    async (req, reply) => {
      const { container } = req.params;
      const { minutes } = req.body;
      if (!minutes || minutes < 1 || minutes > 120) {
        return reply.code(400).send({ error: 'minutes must be 1-120' });
      }
      const until = Math.floor(Date.now() / 1000) + minutes * 60;
      setGrant(container, until);
      return { container, until };
    }
  );

  app.delete<{ Params: { container: string } }>(
    '/api/authz/grants/:container',
    async (req) => {
      deleteGrant(req.params.container);
      return { ok: true };
    }
  );

  app.listen({ port: API_PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error('[api] failed to start', err);
      process.exit(1);
    }
    console.log(`[api] listening on ${address}`);
  });

  return app;
}
