import path from 'path';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import Fastify, { FastifyInstance } from 'fastify';
import { stateEvents, notifyStateChanged } from './events';
import fastifyStatic from '@fastify/static';
import { db, getAllGrants, setGrant, deleteGrant, logAudit, getCredentials, upsertMcpServer, getMcpServer, listMcpServers, deleteMcpServer, getMcpValue, setMcpValue } from './db';
import { parseManifest } from './mcp/types';
import { startMcpContainer, stopMcpContainer, getMcpTargetUrl } from './mcp/manager';
import {
  listDevcontainers,
  inspectContainer,
  commitContainer,
  listSnapshotImages,
  createAndStartContainer,
  getBaseImageName,
  getHuddleNetworks,
  connectNetwork,
  networkExists,
  forceDeleteContainer,
  startExistingContainer,
  cleanupContainerNetwork,
  listNetworks,
  resolveContainerByIp,
  isIdeName,
  execContainerOutput,
  type StartParams,
  type IdeName,
} from './docker';
import { cidrToRange, isDevcontainerSource, type IpRange } from './net-gate';
import { attachTerminal } from './terminal';
import { ptyManager } from './pty-manager';
import { getCaCertPem } from './tls-ca';
import {
  initLoader,
  loadAllExtensions,
  installExtension,
  removeExtension,
  listExtensions,
  extDispatch,
  EXT_DIR,
} from './extensions/registry';

const API_PORT = 3000;
const UI_DIR = path.join(__dirname, '..', 'dist', 'ui', 'browser');

type RuleStatus = 'requested' | 'allow' | 'deny';

interface Rule {
  id: number;
  domain: string;
  container_id: string | null;
  status: RuleStatus;
  expires_at: number | null;
  path_pattern: string | null;
  path_mode: number;
  created_at: number;
  updated_at: number;
  last_seen: number;
  request_count: number;
}

// ── Source-IP gate: deny management-API access from devcontainer networks ──
// The API listens on 0.0.0.0 so the host port forward (-p 3000:3000) works,
// but Huddle is also attached to devcontainer-net and every dc-net-* — without
// this filter, any container on those networks can reach unauth'd /api/* routes.
// Pure IPv4/CIDR-logica zit in net-gate.ts (los testbaar). Hier alleen de live
// cache + Docker-refresh eromheen.
let blockedSubnets: IpRange[] = [];

async function refreshBlockedSubnets(): Promise<void> {
  try {
    const nets = await listNetworks();
    const next: IpRange[] = [];
    for (const n of nets) {
      const name: string = n.Name ?? '';
      if (name !== 'devcontainer-net' && !/^dc-net-/.test(name)) continue;
      for (const cfg of (n.IPAM?.Config ?? [])) {
        const range = cidrToRange(cfg.Subnet);
        if (range) next.push(range);
      }
    }
    blockedSubnets = next;
  } catch (e) {
    console.error('[api] failed to refresh blocked subnets:', (e as Error).message);
  }
}

function isFromDevcontainer(remoteAddr: string | null | undefined): boolean {
  return isDevcontainerSource(remoteAddr, blockedSubnets);
}

export async function createApiServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Build the blocked-subnet cache and refresh it periodically so new
  // dc-net-* networks (created when a devcontainer starts) get picked up.
  refreshBlockedSubnets().catch(() => {});
  setInterval(refreshBlockedSubnets, 5000).unref();

  // Devcontainers may only reach a tiny whitelist of endpoints (currently just
  // the sudo audit ingest). Everything else on the API is admin-only.
  const devcontainerWhitelist: Array<{ method: string; path: string }> = [
    { method: 'POST', path: '/api/audit/sudo' },
    { method: 'GET',  path: '/api/tls/ca.crt' },
  ];
  app.addHook('onRequest', async (req, reply) => {
    if (!isFromDevcontainer(req.socket.remoteAddress)) return;
    const isMcp = (req.url ?? '').startsWith('/mcp/');
    const ok = isMcp || devcontainerWhitelist.some(
      w => w.method === req.method && w.path === req.url,
    );
    if (!ok) {
      reply.code(403).send({ error: 'forbidden', reason: 'endpoint not allowed from devcontainer network' });
    }
  });

  // ── WebSocket push ────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  const wsClients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  // Aparte WSS voor de embedded terminal-tab (/ws/exec/<container>).
  // Houden we los van de state-push wss zodat lifecycle en errorhandling
  // niet door elkaar lopen.
  const wssTerminal = new WebSocketServer({ noServer: true });
  wssTerminal.on('connection', (ws, req) => {
    const m = (req.url ?? '').match(/^\/ws\/exec\/([^/?#]+)/);
    const containerName = m ? decodeURIComponent(m[1]) : '';
    if (!containerName) { ws.close(1008, 'missing container'); return; }
    attachTerminal(ws, containerName).catch((err) => {
      console.warn('[terminal] attach failed:', err.message);
      try { ws.close(1011, 'attach failed'); } catch {}
    });
  });

  // Multi-attach terminal (/ws/terminal/<container>): meerdere clients delen
  // dezelfde Docker exec via de ptyManager. Vervangt op termijn /ws/exec.
  const wssPty = new WebSocketServer({ noServer: true });
  wssPty.on('connection', (ws, req) => {
    const m = (req.url ?? '').match(/^\/ws\/terminal\/([^/?#]+)/);
    const containerName = m ? decodeURIComponent(m[1]) : '';
    if (!containerName) { ws.close(1008, 'missing container'); return; }
    ptyManager.attach(ws, containerName).catch((err) => {
      console.warn('[terminal] pty attach failed:', err.message);
      try { ws.close(1011, 'attach failed'); } catch {}
    });
  });

  function broadcast(): void {
    const msg = JSON.stringify({ type: 'reload' });
    wsClients.forEach((ws) => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch {}
    });
  }

  stateEvents.on('changed', broadcast);

  app.server.on('upgrade', (req, socket, head) => {
    if (isFromDevcontainer((socket as net.Socket).remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const pathname = new URL(req.url ?? '', 'http://x').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname.startsWith('/ws/exec/')) {
      wssTerminal.handleUpgrade(req, socket, head, (ws) => wssTerminal.emit('connection', ws, req));
    } else if (pathname.startsWith('/ws/terminal/')) {
      wssPty.handleUpgrade(req, socket, head, (ws) => wssPty.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  app.register(fastifyStatic, {
    root: UI_DIR,
    prefix: '/',
    wildcard: false,
  });

  app.register(import('@fastify/multipart'), { limits: { fileSize: 10 * 1024 * 1024 } });

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

  app.put<{ Params: { id: string }; Body: { status: RuleStatus; expires_at?: number | null; path_pattern?: string | null } }>(
    '/api/rules/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      const { status, expires_at = null, path_pattern } = req.body;
      if (!['requested', 'allow', 'deny'].includes(status)) {
        return reply.code(400).send({ error: 'invalid status' });
      }
      // path_pattern alleen meewijzigen wanneer de client het expliciet meestuurt
      // (bv. operator verfijnt een requested-subpad bij het goedkeuren). Kan de
      // unieke index (domain, container, pad) raken → 409 bij een duplicaat.
      let result;
      try {
        result = path_pattern !== undefined
          ? db.prepare(`UPDATE rules SET status = ?, expires_at = ?, path_pattern = ?, updated_at = unixepoch() WHERE id = ?`)
              .run(status, expires_at, path_pattern, id)
          : db.prepare(`UPDATE rules SET status = ?, expires_at = ?, updated_at = unixepoch() WHERE id = ?`)
              .run(status, expires_at, id);
      } catch (err: any) {
        return reply.code(409).send({ error: 'duplicate', message: err.message });
      }
      if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
      const updated = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule;
      if (updated.container_id === null && updated.path_pattern === null && (status === 'allow' || status === 'deny')) {
        db.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested' AND path_pattern IS NULL`).run(updated.domain);
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

  // Zet een domein in/uit pad-allowlist modus. Werkt op de host-only regel
  // (path_pattern IS NULL): bij aanzetten wordt het kale domein op 'deny' gezet
  // met path_mode=1, zodat onbekende subpaden voortaan als 'requested' worden
  // opgevoerd i.p.v. stil geweigerd. Uitzetten herstelt 'm naar een gewone
  // host-only deny-regel.
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/rules/:id/path-mode',
    async (req, reply) => {
      const id = Number(req.params.id);
      const { enabled } = req.body;
      const rule = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule | undefined;
      if (!rule) return reply.code(404).send({ error: 'not_found' });
      if (rule.path_pattern !== null) {
        return reply.code(400).send({ error: 'path_mode geldt alleen voor een host-only regel (zonder path_pattern)' });
      }
      if (enabled) {
        db.prepare(`UPDATE rules SET path_mode = 1, status = 'deny', updated_at = unixepoch() WHERE id = ?`).run(id);
      } else {
        db.prepare(`UPDATE rules SET path_mode = 0, updated_at = unixepoch() WHERE id = ?`).run(id);
      }
      const updated = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule;
      logAudit({ containerId: rule.container_id, domain: rule.domain, action: `admin:path-mode-${enabled ? 'on' : 'off'}`, ruleId: id });
      notifyStateChanged();
      return updated;
    }
  );

  app.post<{
    Body: { domain: string; container_id?: string | null; status: RuleStatus; expires_at?: number | null; path_pattern?: string | null };
  }>('/api/rules', async (req, reply) => {
    const { domain, container_id = null, status, expires_at = null, path_pattern = null } = req.body;
    if (!domain || !['requested', 'allow', 'deny'].includes(status)) {
      return reply.code(400).send({ error: 'invalid payload' });
    }
    try {
      const info = db
        .prepare(
          `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern) VALUES (?, ?, ?, ?, ?)`
        )
        .run(domain, container_id, status, expires_at, path_pattern);
      const inserted = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(info.lastInsertRowid) as Rule;
      // Ruim alleen de host-only requested-rij op; padregels per domein blijven
      // staan zodat fijnmazig beleid naast elkaar kan bestaan.
      if (container_id === null && path_pattern === null && (status === 'allow' || status === 'deny')) {
        db.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested' AND path_pattern IS NULL`).run(domain);
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

  app.get('/api/docker/workspaces', async () => {
    const containers = await listDevcontainers();
    return [...new Set(containers.map((c) => c.workspacePath).filter(Boolean))].sort();
  });

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
      const [inspect, rules, globalRules, huddleNets] = await Promise.all([
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
        getHuddleNetworks(),
      ]);
      const huddleInNetwork = huddleNets.has(`dc-net-${req.params.name}`);
      return { inspect, rules, globalRules, huddleInNetwork };
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  // Herverbind huddle aan het dc-net-<name> netwerk van een devcontainer.
  // Nodig wanneer een container na een herstart-cyclus zijn netwerk opnieuw
  // aanmaakt; huddle's oude attachment is dan stale en moet worden opgewerkt.
  app.post<{ Params: { name: string } }>('/api/docker/containers/:name/reconnect-huddle', async (req, reply) => {
    const netName = `dc-net-${req.params.name}`;
    try {
      if (!(await networkExists(netName))) {
        return reply.code(404).send({ error: `network ${netName} does not exist` });
      }
      try { await connectNetwork(netName, 'huddle'); }
      catch (err: any) {
        if (!String(err.message).includes('already exists in network')) throw err;
      }
      notifyStateChanged();
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
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

  app.post<{ Params: { name: string } }>('/api/docker/containers/:name/start', async (req, reply) => {
    const { name } = req.params;
    try {
      const inspect = await inspectContainer(name);
      if (inspect.State?.Running) return { ok: true };
      await startExistingContainer(inspect.Id);
      logAudit({ containerId: name, domain: 'docker', action: 'container:start' });
      notifyStateChanged();
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.delete<{ Params: { name: string } }>('/api/docker/containers/:name', async (req, reply) => {
    const { name } = req.params;
    try {
      const inspect = await inspectContainer(name);
      await forceDeleteContainer(inspect.Id);
      await cleanupContainerNetwork(name);
      notifyStateChanged();
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.get<{ Querystring: { ide?: string } }>('/api/docker/images', async (req) => {
    const ide = isIdeName(req.query.ide) ? req.query.ide : undefined;
    return listSnapshotImages(ide);
  });

  app.get<{ Querystring: { ide?: string } }>('/api/docker/base-image', async (req, reply) => {
    if (!isIdeName(req.query.ide)) {
      return reply.code(400).send({ error: 'ide query param must be "rider", "intellij" or "vscode"' });
    }
    return { imageName: getBaseImageName(req.query.ide), ide: req.query.ide };
  });

  // Huddle's MITM root-CA voor HTTPS-interceptie. Devcontainers downloaden dit
  // certificaat (via de whitelist) en installeren het in de system trust store.
  app.get('/api/tls/ca.crt', async (_req, reply) => {
    return reply
      .header('content-type', 'application/x-x509-ca-cert')
      .send(getCaCertPem());
  });

  app.post<{ Body: { imageName: string; workspaceDir?: string; containerName: string; ideName?: string; empty?: boolean } }>(
    '/api/docker/start',
    async (req, reply) => {
      const { imageName, workspaceDir, containerName, ideName, empty } = req.body;
      if (!imageName || !containerName) {
        return reply.code(400).send({ error: 'imageName and containerName required' });
      }
      if (!empty && !workspaceDir) {
        return reply.code(400).send({ error: 'workspaceDir required when empty is not set' });
      }
      const fwd = (workspaceDir ?? '').replace(/\\/g, '/').replace(/\/$/, '');
      const leaf = empty
        ? containerName.replace(/^devcontainer-/, '') || containerName
        : (fwd.split('/').pop() ?? containerName);
      const ide: IdeName = isIdeName(ideName) ? ideName : 'intellij';
      const params: StartParams = {
        imageName,
        workspaceDir: empty ? '' : fwd,
        containerName,
        containerWorkspace: `/workspaces/${leaf}`,
        presentableName: leaf,
        ideName: ide,
        empty: empty === true,
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

  // ── Container credentials ─────────────────────────────────────────────────
  app.get<{ Params: { name: string } }>('/api/docker/containers/:name/credentials', async (req, reply) => {
    const creds = getCredentials(req.params.name);
    if (!creds) return reply.code(404).send({ error: 'not_found' });
    return { password: creds.password, createdAt: creds.created_at };
  });

  // ── IDE gateway link ─────────────────────────────────────────────────────
  app.get<{ Params: { name: string } }>('/api/docker/containers/:name/ide-link', async (req, reply) => {
    try {
      const inspect = await inspectContainer(req.params.name);
      const labels = inspect?.Config?.Labels;
      const workspacePath: string | undefined = labels?.['com.intellij.devcontainer.workspace.path'];
      if (!workspacePath) return reply.code(404).send({ error: 'workspace path label not found' });
      const ide = labels?.['com.devcontainer.ide'];
      // VS Code installeert zijn eigen backend bij het attachen en schrijft geen
      // jetbrains-gateway://-link; een deep-link bestaat hier niet.
      if (ide === 'vscode') {
        return reply.code(404).send({ error: 'VS Code gebruikt geen JetBrains deep-link' });
      }
      // Rider en IntelliJ draaien beide remote-dev-server.sh, dat de gateway-link
      // naar <workspace>/rider-client-diagnose.log schrijft.
      const logFile = `${workspacePath}/rider-client-diagnose.log`;
      const output = await execContainerOutput(inspect.Id, [
        'sh', '-c',
        `grep -rho 'jetbrains-gateway://[^ ]*' /.jbdevcontainer/JetBrains/ "${logFile}" 2>/dev/null | tail -1`,
      ]);
      const links = output.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('jetbrains-gateway://'));
      if (links.length === 0) return reply.code(404).send({ error: 'IDE backend nog niet gestart — even geduld en probeer opnieuw' });
      return { link: links[links.length - 1] };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── Sudo audit ingest ─────────────────────────────────────────────────────
  // Container identity is derived from the source IP — the body's `container`
  // field is ignored. A devcontainer cannot impersonate another container by
  // sending a forged name.
  app.post<{ Body: { entry: string } }>('/api/audit/sudo', async (req, reply) => {
    const { entry } = req.body;
    if (!entry) return { ok: false };
    const container = await resolveContainerByIp(req.socket.remoteAddress ?? '');
    if (!container) {
      reply.code(403);
      return { ok: false, error: 'unknown source container' };
    }
    // Parse sudo log: "... user : TTY=... ; PWD=... ; USER=root ; COMMAND=/usr/bin/foo bar"
    const cmdMatch = entry.match(/COMMAND=(.+)$/);
    const cmd = cmdMatch ? cmdMatch[1].trim() : entry;
    const cmdBase = cmd.split('/').pop()?.split(' ')[0] ?? 'unknown';
    logAudit({
      containerId: container,
      domain: 'sudo',
      action: `sudo:${cmdBase}`,
      method: null,
      path: cmd.length > 200 ? cmd.slice(0, 200) : cmd,
    });
    notifyStateChanged();
    return { ok: true };
  });

  // ── Extensions ────────────────────────────────────────────────────────────
  // Catch-all voor extensie API-routes. Moet VOOR loadAllExtensions() staan
  // zodat hij geregistreerd is vóór listen() — extensies schrijven naar
  // extDispatch i.p.v. direct routes op Fastify te zetten.
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    url: '/api/ext/:extId/*',
    handler: async (req: any, reply) => {
      const extId: string = req.params.extId;
      const sub: string = req.params['*'] ?? '';
      const fullPath = `/api/ext/${extId}/${sub}`;
      const handler = extDispatch.get(`${req.method}:${fullPath}`);
      if (!handler) return reply.code(404).send({ error: `Geen handler voor ${req.method} ${fullPath}` });
      return handler(req, reply);
    },
  });

  app.get('/api/extensions', async () => listExtensions());

  app.post('/api/extensions/upload', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'Geen bestand' });
    const buffer = await data.toBuffer();
    try {
      const result = await installExtension(buffer);
      notifyStateChanged();
      return result;
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/extensions/:id', async (req, reply) => {
    if (!/^[a-z0-9-]+$/.test(req.params.id)) {
      return reply.code(400).send({ error: 'ongeldige id' });
    }
    removeExtension(req.params.id);
    notifyStateChanged();
    return { ok: true };
  });

  // ── MCP Servers ───────────────────────────────────────────────────────────

  function rowToMcpServer(row: any): any {
    const manifest = JSON.parse(row.manifest_json);
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      image: row.image,
      port: row.port,
      transport: row.transport,
      settings: manifest.settings ?? [],
      containerId: row.container_id,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  app.get('/api/mcp', async () => listMcpServers().map(rowToMcpServer));

  app.post('/api/mcp/upload', async (req, reply) => {
    let body: unknown;
    try {
      body = typeof (req as any).body === 'string' ? JSON.parse((req as any).body) : (req as any).body;
    } catch {
      return reply.code(400).send({ error: 'Ongeldige JSON' });
    }
    let manifest: ReturnType<typeof parseManifest>;
    try {
      manifest = parseManifest(body);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
    upsertMcpServer({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      image: manifest.image,
      port: manifest.port,
      transport: manifest.transport,
      manifest_json: JSON.stringify(manifest),
      container_id: null,
      status: 'stopped',
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    });
    notifyStateChanged();
    return { id: manifest.id, name: manifest.name };
  });

  app.delete<{ Params: { id: string } }>('/api/mcp/:id', async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send({ error: 'Ongeldige id' });
    const row = getMcpServer(id);
    if (!row) return reply.code(404).send({ error: 'Niet gevonden' });
    if (row.status === 'running') {
      try { await stopMcpContainer(id); } catch {}
    }
    deleteMcpServer(id);
    notifyStateChanged();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/mcp/:id/start', async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send({ error: 'Ongeldige id' });
    try {
      await startMcpContainer(id);
      notifyStateChanged();
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/mcp/:id/stop', async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send({ error: 'Ongeldige id' });
    try {
      await stopMcpContainer(id);
      notifyStateChanged();
      return { ok: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/mcp/:id/settings', async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send({ error: 'Ongeldige id' });
    const row = getMcpServer(id);
    if (!row) return reply.code(404).send({ error: 'Niet gevonden' });
    const manifest = JSON.parse(row.manifest_json);
    const settings: Array<{ key: string; secret?: boolean }> = manifest.settings ?? [];
    const result: Record<string, string> = {};
    for (const s of settings) {
      result[s.key] = s.secret ? '' : (getMcpValue(id, s.key) ?? '');
    }
    return result;
  });

  app.post<{ Params: { id: string }; Body: Record<string, string> }>('/api/mcp/:id/settings', async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send({ error: 'Ongeldige id' });
    const row = getMcpServer(id);
    if (!row) return reply.code(404).send({ error: 'Niet gevonden' });
    const body = (req as any).body as Record<string, string>;
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === 'string') setMcpValue(id, k, v);
    }
    return { ok: true };
  });

  // MCP proxy — stuurt verkeer door naar de draaiende MCP-container
  // Route: /mcp/:id/* (niet onder /api/ zodat SSE-streaming werkt via raw reply)
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: '/mcp/:id/*',
    handler: async (req: any, reply) => {
      const id: string = req.params.id;
      if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send({ error: 'Ongeldige id' });
      let targetBase: string;
      try {
        targetBase = await getMcpTargetUrl(id);
      } catch (err: any) {
        return reply.code(503).send({ error: err.message });
      }
      const subPath = '/' + (req.params['*'] ?? '');
      const targetUrl = new URL(subPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''), targetBase);

      return new Promise<void>((resolve, reject) => {
        const proxyReq = http.request(
          {
            host: targetUrl.hostname,
            port: Number(targetUrl.port) || 80,
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: { ...req.headers, host: targetUrl.host },
          },
          (proxyRes) => {
            reply.raw.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(reply.raw);
            proxyRes.on('end', resolve);
            proxyRes.on('error', reject);
          }
        );
        proxyReq.on('error', reject);
        const parsedBody = (req as any).body;
        if (parsedBody !== undefined && parsedBody !== null) {
          const bodyStr = typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody);
          proxyReq.setHeader('content-length', String(Buffer.byteLength(bodyStr)));
          proxyReq.end(bodyStr);
        } else {
          proxyReq.end();
        }
      });
    },
  });

  initLoader(app, db);
  await loadAllExtensions();

  // Serveer de statische frontend-assets van een extensie uit
  // <EXT_DIR>/<id>/frontend/. Het opgeloste pad moet binnen die map blijven,
  // anders is het een traversal-poging (bv. ../../).
  app.get<{ Params: { id: string; '*': string } }>('/ext/:id/*', async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send('ongeldige id');
    const subPath = req.params['*'] || 'index.html';
    const baseDir = path.join(EXT_DIR, id, 'frontend');
    const filePath = path.join(baseDir, subPath);
    if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
      return reply.code(403).send('verboden');
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return reply.code(404).send('Niet gevonden');
    }
    return reply.send(fs.createReadStream(filePath));
  });

  // Serve Angular index.html for any non-API route (hash routing — browser never sends fragment)
  app.setNotFoundHandler(async (_req, reply) => {
    return reply.sendFile('index.html');
  });

  const address = await app.listen({ port: API_PORT, host: '0.0.0.0' });
  console.log(`[api] listening on ${address}`);

  return app;
}
