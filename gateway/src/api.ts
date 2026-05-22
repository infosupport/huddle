import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import Fastify, { FastifyInstance } from 'fastify';
import { stateEvents, notifyStateChanged } from './events';
import fastifyStatic from '@fastify/static';
import { db, getAllGrants, setGrant, deleteGrant, logAudit } from './db';
import {
  listDevcontainers,
  inspectContainer,
  commitContainer,
  listSnapshotImages,
  createAndStartContainer,
  getBaseImageName,
  forceDeleteContainer,
  cleanupContainerNetwork,
  type StartParams,
} from './docker';

const API_PORT = 3000;
const UI_DIR = path.join(__dirname, '..', 'dist', 'ui', 'browser');

type RuleStatus = 'requested' | 'allow' | 'deny';

interface Rule {
  id: number;
  domain: string;
  container_id: string | null;
  status: RuleStatus;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_seen: number;
  request_count: number;
}

export function createApiServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  // ── WebSocket push ────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  const wsClients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  function broadcast(): void {
    const msg = JSON.stringify({ type: 'reload' });
    wsClients.forEach((ws) => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch {}
    });
  }

  stateEvents.on('changed', broadcast);

  app.server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '', 'http://x').pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  app.register(fastifyStatic, {
    root: UI_DIR,
    prefix: '/',
    wildcard: false,
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

  app.put<{ Params: { id: string }; Body: { status: RuleStatus; expires_at?: number | null } }>(
    '/api/rules/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      const { status, expires_at = null } = req.body;
      if (!['requested', 'allow', 'deny'].includes(status)) {
        return reply.code(400).send({ error: 'invalid status' });
      }
      const result = db
        .prepare(`UPDATE rules SET status = ?, expires_at = ?, updated_at = unixepoch() WHERE id = ?`)
        .run(status, expires_at, id);
      if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
      const updated = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule;
      if (updated.container_id === null && (status === 'allow' || status === 'deny')) {
        db.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested'`).run(updated.domain);
      }
      logAudit({ containerId: updated.container_id, domain: updated.domain, action: `admin:rule-${status}`, ruleId: id });
      notifyStateChanged();
      return updated;
    }
  );

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const rule = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule | undefined;
    if (!rule) return reply.code(404).send({ error: 'not_found' });
    db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
    logAudit({ containerId: rule.container_id, domain: rule.domain, action: 'admin:rule-delete', ruleId: id });
    notifyStateChanged();
    return { ok: true };
  });

  app.post<{
    Body: { domain: string; container_id?: string | null; status: RuleStatus; expires_at?: number | null };
  }>('/api/rules', async (req, reply) => {
    const { domain, container_id = null, status, expires_at = null } = req.body;
    if (!domain || !['requested', 'allow', 'deny'].includes(status)) {
      return reply.code(400).send({ error: 'invalid payload' });
    }
    try {
      const info = db
        .prepare(
          `INSERT INTO rules (domain, container_id, status, expires_at) VALUES (?, ?, ?, ?)`
        )
        .run(domain, container_id, status, expires_at);
      const inserted = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(info.lastInsertRowid) as Rule;
      if (container_id === null && (status === 'allow' || status === 'deny')) {
        db.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested'`).run(domain);
      }
      logAudit({ containerId: container_id, domain, action: `admin:rule-${status}`, ruleId: Number(info.lastInsertRowid) });
      notifyStateChanged();
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
      const [inspect, rules, globalRules] = await Promise.all([
        inspectContainer(req.params.name),
        Promise.resolve(
          db
            .prepare(`SELECT * FROM rules WHERE container_id = ? ORDER BY status, domain`)
            .all(req.params.name) as Rule[]
        ),
        Promise.resolve(
          db
            .prepare(`SELECT * FROM rules WHERE container_id IS NULL ORDER BY status, domain`)
            .all() as Rule[]
        ),
      ]);
      return { inspect, rules, globalRules };
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

  app.delete<{ Params: { name: string } }>('/api/docker/containers/:name', async (req, reply) => {
    const { name } = req.params;
    try {
      const inspect = await inspectContainer(name);
      await forceDeleteContainer(inspect.Id);
      await cleanupContainerNetwork(name);
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

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
      logAudit({ containerId: container, domain: 'docker-access', action: `admin:grant-${minutes}m` });
      notifyStateChanged();
      return { container, until };
    }
  );

  app.delete<{ Params: { container: string } }>(
    '/api/authz/grants/:container',
    async (req) => {
      const { container } = req.params;
      deleteGrant(container);
      logAudit({ containerId: container, domain: 'docker-access', action: 'admin:grant-revoke' });
      notifyStateChanged();
      return { ok: true };
    }
  );

  // ── Audit log ─────────────────────────────────────────────────────────────

  app.get<{ Querystring: { container?: string; domain?: string; action?: string; limit?: string; offset?: string } }>(
    '/api/audit',
    async (req) => {
      const { container, domain, action, limit = '200', offset = '0' } = req.query;
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (container) { where.push('container_id = ?'); params.push(container); }
      if (domain) { where.push('domain LIKE ?'); params.push(`%${domain}%`); }
      if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
      const sql =
        `SELECT * FROM audit_log` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ts DESC LIMIT ? OFFSET ?`;
      return db.prepare(sql).all(...params, Math.min(Number(limit) || 200, 1000), Number(offset) || 0);
    }
  );

  app.get('/api/audit/debug', async () => {
    const dbPath = process.env.DB_PATH ?? '/data/huddle.db';
    const before = (db.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }).n;
    let insertError: string | null = null;
    let insertedId: number | null = null;
    try {
      const r = db.prepare(
        `INSERT INTO audit_log (container_id, domain, port, action, rule_id, method, path, req_headers, req_body, res_status, res_headers, res_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(null, 'debug.test', null, 'debug:ping', null, 'GET', '/api/audit/debug', null, null, 200, null, null);
      insertedId = Number(r.lastInsertRowid);
    } catch (err: any) {
      insertError = err.message;
    }
    const after = (db.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }).n;
    const last5 = db.prepare('SELECT id, ts, container_id, domain, action FROM audit_log ORDER BY ts DESC LIMIT 5').all();
    return { dbPath, rowsBefore: before, rowsAfter: after, insertedId, insertError, last5 };
  });

  // ── Bug tracker ───────────────────────────────────────────────────────────

  const BUGS_BASE = process.env.BUGS_DIR ?? '/bugtracker';

  app.post<{ Body: { title: string; url: string; body?: string } }>(
    '/api/bugs',
    async (req, reply) => {
      const { title, url, body = '' } = req.body;
      if (!title?.trim()) return reply.code(400).send({ error: 'title required' });

      const bugsDir = path.join(BUGS_BASE, 'bugs');
      try {
        fs.mkdirSync(bugsDir, { recursive: true });
        fs.mkdirSync(path.join(BUGS_BASE, 'solved'), { recursive: true });
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
        const now = new Date();
        const ts = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
        const filename = `${ts}-${slug}.md`;
        const dateStr = now.toLocaleString('nl-NL');
        const content = `# ${title}\n\n**URL**: ${url}\n**Datum**: ${dateStr}\n\n${body}`.trimEnd() + '\n';
        fs.writeFileSync(path.join(bugsDir, filename), content, 'utf8');
        return { ok: true, filename };
      } catch (err: any) {
        return reply.code(500).send({ error: 'cannot write bug file', message: err.message });
      }
    }
  );

  app.get('/api/bugs', async (_req, reply) => {
    const bugsDir = path.join(BUGS_BASE, 'bugs');
    const solvedDir = path.join(BUGS_BASE, 'solved');
    try {
      const readDir = (dir: string) => {
        try {
          return fs.readdirSync(dir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .map(f => ({ filename: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
        } catch { return []; }
      };
      return { bugs: readDir(bugsDir), solved: readDir(solvedDir) };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Serve Angular index.html for any non-API route (hash routing — browser never sends fragment)
  app.setNotFoundHandler(async (_req, reply) => {
    return reply.sendFile('index.html');
  });

  app.listen({ port: API_PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error('[api] failed to start', err);
      process.exit(1);
    }
    console.log(`[api] listening on ${address}`);
  });

  return app;
}
