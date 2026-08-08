import path from 'path';
import fs from 'fs';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Fastify, { FastifyInstance } from 'fastify';
import { stateEvents, notifyStateChanged } from './events';
import fastifyStatic from '@fastify/static';
import { db, getAllGrants, setGrant, deleteGrant, getGrant, setActionPolicy, logAudit, getSudoGrant, getAirlocked, setAirlocked, getSetting, setSetting, listFolderMappings, getFolderMapping, createFolderMapping, updateFolderMapping, deleteFolderMapping, FolderMapping, listApprovedHostPorts, addApprovedHostPort, removeApprovedHostPort, ApprovedHostPort } from './db';
import { DOCKER_ACTIONS, getEffectivePolicies, isKnownAction } from './docker-actions';
import { ensurePathModeMarker } from './rules';
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
  resolveContainerByIp,
  isIdeName,
  execContainerOutput,
  execInContainer,
  type StartParams,
  type IdeName,
} from './docker';
import { grantSudo, revokeSudo } from './sudo-grant';
import {
  getOperatorToken,
  isAuthenticated,
  timingSafeEqualStr,
  isAllowedOrigin,
  sessionCookie,
  clearSessionCookie,
} from './auth';
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

export async function createApiServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // A single access model for the entire management API: the operator token (auth.ts).
  // Source IP tells us nothing reliable here — Docker's proxy and Podman's
  // rootlessport rewrite the source to a bridge-gateway IP, and under rootless
  // Podman even which network that is changes per restart/disconnect
  // (GetRootlessPortChildIP iterates a map). Devcontainers, LAN and operator can
  // therefore only be distinguished by the token; the former subnet gate has
  // therefore been replaced by auth on every /api/* route.
  //
  // Endpoints that devcontainers must be able to reach WITHOUT a token (sudo-audit
  // ingest and the proxy CA). Keep this deliberately minimal: everything here is
  // callable by anyone on the network.
  const devcontainerPublicApi: Array<{ method: string; path: string }> = [
    { method: 'POST', path: '/api/audit/sudo' },
    { method: 'GET',  path: '/api/tls/ca.crt' },
  ];
  // Endpoints that the operator browser/CLI must be able to reach without a
  // logged-in session in order to be able to log in at all (and to see THAT login
  // is required). The static SPA assets fall under this too (everything outside
  // /api/): it is only client code, and the API itself stays behind auth.
  const authPublicApi = new Set<string>(['/api/auth/login', '/api/auth/logout', '/api/auth/status']);

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0];
    if (!pathOnly.startsWith('/api/')) return;      // static SPA assets are free
    if (authPublicApi.has(pathOnly)) return;         // login/logout/status are free
    if (devcontainerPublicApi.some(w => w.method === req.method && w.path === pathOnly)) return;
    if (!isAuthenticated(req.headers)) {
      reply.code(401).send({ error: 'unauthorized', reason: 'operator authentication required' });
    }
  });

  // ── Auth endpoints ─────────────────────────────────────────────────────────
  // Login: verify the token (constant-time) and on success set an httpOnly,
  // SameSite=Strict session cookie. SameSite=Strict is at once the CSRF/CSWSH
  // defense (finding #4): the browser does not send the cookie on cross-site
  // requests or WebSocket handshakes.
  app.post<{ Body: { token?: string } }>('/api/auth/login', async (req, reply) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!token || !timingSafeEqualStr(token, getOperatorToken())) {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    reply.header('set-cookie', sessionCookie(token));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', clearSessionCookie());
    return { ok: true };
  });

  app.get('/api/auth/status', async (req) => {
    return { authenticated: isAuthenticated(req.headers) };
  });

  // ── WebSocket push ────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  const wsClients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  // Separate WSS for the embedded terminal tab (/ws/exec/<container>).
  // We keep it separate from the state-push wss so that lifecycle and error
  // handling do not get intertwined.
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

  // Multi-attach terminal (/ws/terminal/<container>): multiple clients share the
  // same Docker exec via the ptyManager. Will eventually replace /ws/exec.
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
    // Cross-Site WebSocket Hijacking (finding #4): a page the operator visits
    // must not be able to open a WS to the portal. Two independent layers:
    // (1) Origin must be same-origin; (2) a valid operator session (cookie/
    // bearer) is required — and thanks to SameSite=Strict that cookie does not
    // travel along on a cross-site handshake anyway.
    if (!isAllowedOrigin(req.headers['origin'] as string | undefined, req.headers['host'])) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isAuthenticated(req.headers)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
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
      // Only change path_pattern when the client explicitly sends it (e.g. the
      // operator refines a requested subpath on approval). May hit the unique
      // index (domain, container, path) → 409 on a duplicate.
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

  app.post<{
    Params: { id: string };
    Body: {
      status: RuleStatus;
      scope?: 'rule' | 'global';
      expires_at?: number | null;
      path_pattern?: string | null;
    };
  }>('/api/rules/:id/resolve', async (req, reply) => {
    const id = Number(req.params.id);
    const { status, scope = 'rule', expires_at = null } = req.body;
    const hasPathPattern = Object.prototype.hasOwnProperty.call(req.body, 'path_pattern');
    const nextPathPattern = hasPathPattern ? (req.body.path_pattern ?? null) : undefined;

    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid rule id' });
    }
    if (status !== 'allow' && status !== 'deny') {
      return reply.code(400).send({ error: 'status must be "allow" or "deny"' });
    }
    if (scope !== 'rule' && scope !== 'global') {
      return reply.code(400).send({ error: 'scope must be "rule" or "global"' });
    }

    const rule = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule | undefined;
    if (!rule) return reply.code(404).send({ error: 'not_found' });

    if (scope === 'rule') {
      try {
        if (hasPathPattern) {
          db.prepare(
            `UPDATE rules SET status = ?, expires_at = ?, path_pattern = ?, updated_at = unixepoch() WHERE id = ?`
          ).run(status, expires_at, nextPathPattern, id);
        } else {
          db.prepare(
            `UPDATE rules SET status = ?, expires_at = ?, updated_at = unixepoch() WHERE id = ?`
          ).run(status, expires_at, id);
        }
      } catch (err: any) {
        return reply.code(409).send({ error: 'duplicate', message: err.message });
      }

      const updated = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule;
      if (updated.container_id === null && updated.path_pattern === null) {
        db.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested' AND path_pattern IS NULL`).run(updated.domain);
      }
      logAudit({ containerId: updated.container_id, domain: updated.domain, action: `admin:rule-${status}`, ruleId: id });
      notifyStateChanged();
      return updated;
    }

    const globalPathPattern = hasPathPattern ? nextPathPattern! : rule.path_pattern;
    let globalRule = db.prepare(
      `SELECT * FROM rules
       WHERE domain = ? AND container_id IS NULL AND COALESCE(path_pattern, '') = COALESCE(?, '')`
    ).get(rule.domain, globalPathPattern) as Rule | undefined;

    try {
      if (globalRule) {
        db.prepare(`UPDATE rules SET status = ?, expires_at = ?, updated_at = unixepoch() WHERE id = ?`)
          .run(status, expires_at, globalRule.id);
      } else {
        const info = db.prepare(
          `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern) VALUES (?, NULL, ?, ?, ?)`
        ).run(rule.domain, status, expires_at, globalPathPattern);
        globalRule = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(info.lastInsertRowid) as Rule;
      }
    } catch (err: any) {
      return reply.code(409).send({ error: 'duplicate', message: err.message });
    }

    const updatedGlobal = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(globalRule.id) as Rule;
    if (globalPathPattern === null) {
      db.prepare(`DELETE FROM rules WHERE domain = ? AND status = 'requested' AND path_pattern IS NULL`).run(rule.domain);
    } else if (rule.container_id !== null) {
      db.prepare(`DELETE FROM rules WHERE id = ?`).run(rule.id);
    }

    logAudit({ containerId: null, domain: rule.domain, action: `admin:rule-${status}-global`, ruleId: updatedGlobal.id });
    notifyStateChanged();
    return updatedGlobal;
  });

  // Toggle path-allowlist mode for a domain on/off. Operates on the host-only rule
  // (path_pattern IS NULL): when enabled the bare domain is set to 'deny' with
  // path_mode=1, so unknown subpaths are henceforth raised as 'requested' instead
  // of being silently denied. Disabling restores it to a plain host-only deny rule.
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/rules/:id/path-mode',
    async (req, reply) => {
      const id = Number(req.params.id);
      const { enabled } = req.body;
      const rule = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule | undefined;
      if (!rule) return reply.code(404).send({ error: 'not_found' });
      if (rule.path_pattern !== null) {
        return reply.code(400).send({ error: 'path_mode only applies to a host-only rule (without path_pattern)' });
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
    // Explicitly require a non-empty string: a truthy non-string domain (e.g. a
    // number/object in the JSON) would otherwise blow up later with a 500 instead
    // of this clean 400.
    if (typeof domain !== 'string' || !domain || !['requested', 'allow', 'deny'].includes(status)) {
      return reply.code(400).send({ error: 'invalid payload' });
    }
    // Store the domain as supplied — no casing mutation. The rule engine already
    // matches case-insensitively (COLLATE NOCASE in db.ts + canonicalizeHost/
    // matchDomain, finding #3), so lowercasing is redundant and would change the
    // echo-back to clients.
    try {
      const info = db
        .prepare(
          `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern) VALUES (?, ?, ?, ?, ?)`
        )
        .run(domain, container_id, status, expires_at, path_pattern);
      const inserted = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(info.lastInsertRowid) as Rule;
      // Only clean up the host-only requested row; per-domain path rules remain so
      // fine-grained policy can coexist. COLLATE NOCASE: requested rows are created
      // lowercase (proxy/canonicalizeHost), so they also match when the operator
      // supplies mixed-case here.
      if (container_id === null && path_pattern === null && (status === 'allow' || status === 'deny')) {
        db.prepare(`DELETE FROM rules WHERE domain = ? COLLATE NOCASE AND status = 'requested' AND path_pattern IS NULL`).run(domain);
      }
      // A path-scoped rule is inert over HTTPS unless its domain is in path-mode
      // (finding #6a): establish the host-only path_mode=1 marker so the CONNECT
      // is admitted and the path rule can actually fire, matching the portal flow.
      if (path_pattern !== null) {
        ensurePathModeMarker(domain, container_id);
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
    return containers.map((c) => ({ ...c, requestedCount: countMap.get(c.name) ?? 0, airlocked: getAirlocked(c.name) }));
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
      return { inspect, rules, globalRules, huddleInNetwork, airlocked: getAirlocked(req.params.name) };
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  // Reconnect huddle to a devcontainer's dc-net-<name> network. Needed when a
  // container recreates its network after a restart cycle; huddle's old attachment
  // is then stale and must be refreshed.
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

  app.post<{ Params: { name: string }; Body: { airlocked?: boolean } }>(
    '/api/docker/containers/:name/airlock',
    async (req) => {
      const current = getAirlocked(req.params.name);
      const next = typeof req.body?.airlocked === 'boolean' ? req.body.airlocked : !current;
      setAirlocked(req.params.name, next);
      logAudit({ containerId: req.params.name, domain: 'docker', action: next ? 'airlock:on' : 'airlock:off' });
      notifyStateChanged();
      return { airlocked: next };
    }
  );

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

  // Huddle's MITM root CA for HTTPS interception. Devcontainers download this
  // certificate (via the whitelist) and install it in the system trust store.
  app.get('/api/tls/ca.crt', async (_req, reply) => {
    return reply
      .header('content-type', 'application/x-x509-ca-cert')
      .send(getCaCertPem());
  });

  app.post<{ Body: { imageName: string; workspaceDir?: string; containerName: string; ideName?: string; empty?: boolean; presentableName?: string; memory?: string; cpus?: string } }>(
    '/api/docker/start',
    async (req, reply) => {
      const { imageName, workspaceDir, containerName, ideName, empty, presentableName: presentableNameOverride, memory, cpus } = req.body;
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
        presentableName: presentableNameOverride || leaf,
        ideName: ide,
        empty: empty === true,
        memory,
        cpus,
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

  // ── Fijnmazige Docker-actie-rechten ───────────────────────────────────────

  app.get('/api/authz/docker-actions', async () => ({ actions: DOCKER_ACTIONS }));

  app.get<{ Params: { container: string } }>(
    '/api/authz/docker-actions/:container',
    async (req) => {
      const { container } = req.params;
      return {
        policies: getEffectivePolicies(container),
        grant: getGrant(container),
      };
    }
  );

  app.put<{ Params: { container: string; action: string }; Body: { enabled: boolean } }>(
    '/api/authz/docker-actions/:container/:action',
    async (req, reply) => {
      const { container, action } = req.params;
      const { enabled } = req.body ?? {};
      if (!isKnownAction(action)) {
        return reply.code(400).send({ error: `unknown docker action '${action}'` });
      }
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled must be a boolean' });
      }
      setActionPolicy(container, action, enabled);
      logAudit({
        containerId: container,
        domain: 'docker-access',
        action: `admin:docker-action-${action}-${enabled ? 'on' : 'off'}`,
      });
      notifyStateChanged();
      return { container, action, enabled };
    }
  );

  // ── Client-side logging (frontend → container logs) ──────────────────────
  // The Angular UI sends uncaught runtime errors here so they are visible in
  // `docker logs huddle`. Only log, persist nothing.

  app.post<{ Body: { level?: string; message?: string; stack?: string; url?: string } }>(
    '/api/client-log',
    async (req) => {
      const { level = 'error', message = '', stack, url } = req.body ?? {};
      const lvl = String(level).slice(0, 10);
      const line = `[client:${lvl}] ${String(message).slice(0, 2000)}${url ? ` @ ${String(url).slice(0, 300)}` : ''}`;
      console.error(line);
      if (stack) console.error(`[client:${lvl}] ${String(stack).slice(0, 6000)}`);
      return { ok: true };
    }
  );

  // ── Audit log ─────────────────────────────────────────────────────────────

  app.get<{ Querystring: { container?: string; domain?: string; action?: string; path?: string; limit?: string; offset?: string } }>(
    '/api/audit',
    async (req) => {
      const { container, domain, action, path, limit = '200', offset = '0' } = req.query;
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (container) { where.push('container_id = ?'); params.push(container); }
      if (domain) { where.push('domain LIKE ?'); params.push(`%${domain}%`); }
      if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
      if (path) { where.push('path LIKE ?'); params.push(`%${path}%`); }
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

  // ── Ephemeral sudo grant (admin access to 'noot') ─────────────────────────
  // The 'noot' admin user starts LOCKED without a password. Admin access is now
  // temporary: a grant sets a FRESH password in the container, unlocks the account
  // for `minutes` minutes, and returns the password EXACTLY ONCE. On expiry
  // (sweeper) or revoke the account is locked again. No (plaintext or hashed)
  // password is stored (finding #10).

  // Status: is there an active grant and until when? NEVER returns a (reusable)
  // password — replaces the old /credentials endpoint.
  app.get<{ Params: { name: string } }>('/api/docker/containers/:name/sudo-grant', async (req) => {
    const grant = getSudoGrant(req.params.name);
    const now = Math.floor(Date.now() / 1000);
    const active = !!grant && grant.until > now;
    return { active, until: active ? grant!.until : null };
  });

  // Grant admin access: generate a password, set+unlock in the container, store the
  // grant and return the password once. Fail closed: if the exec fails, no grant is
  // stored and a 500 follows.
  app.post<{ Params: { name: string }; Body: { minutes: number } }>(
    '/api/docker/containers/:name/sudo-grant',
    async (req, reply) => {
      const { name } = req.params;
      const { minutes } = req.body ?? {};
      if (!minutes || minutes < 1 || minutes > 120) {
        return reply.code(400).send({ error: 'minutes must be 1-120' });
      }
      try {
        const { password, until } = await grantSudo(name, minutes, execInContainer);
        // Audit WITHOUT the password — never plaintext in the log.
        logAudit({ containerId: name, domain: 'sudo', action: `admin:sudo-grant-${minutes}m` });
        notifyStateChanged();
        return { password, until };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Revoke admin access immediately: lock 'noot' and delete the grant.
  app.delete<{ Params: { name: string } }>(
    '/api/docker/containers/:name/sudo-grant',
    async (req) => {
      const { name } = req.params;
      await revokeSudo(name, execInContainer);
      logAudit({ containerId: name, domain: 'sudo', action: 'admin:sudo-grant-revoke' });
      notifyStateChanged();
      return { ok: true };
    }
  );

  // ── IDE gateway link ─────────────────────────────────────────────────────
  app.get<{ Params: { name: string } }>('/api/docker/containers/:name/ide-link', async (req, reply) => {
    try {
      const inspect = await inspectContainer(req.params.name);
      const labels = inspect?.Config?.Labels;
      const workspacePath: string | undefined = labels?.['com.intellij.devcontainer.workspace.path'];
      if (!workspacePath) return reply.code(404).send({ error: 'workspace path label not found' });
      const ide = labels?.['com.devcontainer.ide'];
      // VS Code installs its own backend on attach and does not write a
      // jetbrains-gateway:// link; a deep link does not exist here.
      if (ide === 'vscode') {
        return reply.code(404).send({ error: 'VS Code does not use a JetBrains deep-link' });
      }
      // Rider and IntelliJ both run remote-dev-server.sh, which writes the gateway
      // link to <workspace>/rider-client-diagnose.log.
      const logFile = `${workspacePath}/rider-client-diagnose.log`;
      const output = await execContainerOutput(inspect.Id, [
        'sh', '-c',
        `grep -rho 'jetbrains-gateway://[^ ]*' /.jbdevcontainer/JetBrains/ "${logFile}" 2>/dev/null | tail -1`,
      ]);
      const links = output.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('jetbrains-gateway://'));
      if (links.length === 0) return reply.code(404).send({ error: 'IDE backend not started yet — please wait and try again' });
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
  // Catch-all for extension API routes. Must come BEFORE loadAllExtensions() so
  // it is registered before listen() — extensions write to extDispatch instead of
  // putting routes directly on Fastify.
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    url: '/api/ext/:extId/*',
    handler: async (req: any, reply) => {
      const extId: string = req.params.extId;
      const sub: string = req.params['*'] ?? '';
      const fullPath = `/api/ext/${extId}/${sub}`;
      let handler = extDispatch.get(`${req.method}:${fullPath}`);
      if (!handler) {
        // Pattern matching for routes with :param segments
        for (const [key, h] of extDispatch) {
          const firstColon = key.indexOf(':');
          const km = key.slice(0, firstColon);
          const kp = key.slice(firstColon + 1);
          if (km !== req.method) continue;
          const patParts = kp.split('/');
          const actParts = fullPath.split('/');
          if (patParts.length !== actParts.length) continue;
          const params: Record<string, string> = {};
          let match = true;
          for (let i = 0; i < patParts.length; i++) {
            if (patParts[i].startsWith(':')) {
              params[patParts[i].slice(1)] = decodeURIComponent(actParts[i]);
            } else if (patParts[i] !== actParts[i]) {
              match = false;
              break;
            }
          }
          if (match) { req.params = { ...req.params, ...params }; handler = h; break; }
        }
      }
      if (!handler) return reply.code(404).send({ error: `No handler for ${req.method} ${fullPath}` });
      return handler(req, reply);
    },
  });

  app.get('/api/extensions', async () => listExtensions());

  app.post('/api/extensions/upload', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file' });
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
      return reply.code(400).send({ error: 'invalid id' });
    }
    removeExtension(req.params.id);
    notifyStateChanged();
    return { ok: true };
  });


  initLoader(app, db);
  await loadAllExtensions();

  // Serve an extension's static frontend assets from <EXT_DIR>/<id>/frontend/.
  // The resolved path must stay within that directory, otherwise it is a traversal
  // attempt (e.g. ../../).
  app.get<{ Params: { id: string; '*': string } }>('/ext/:id/*', async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]+$/.test(id)) return reply.code(400).send('invalid id');
    const subPath = req.params['*'] || 'index.html';
    const baseDir = path.join(EXT_DIR, id, 'frontend');
    const filePath = path.join(baseDir, subPath);
    if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
      return reply.code(403).send('forbidden');
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return reply.code(404).send('Not found');
    }
    return reply.send(fs.createReadStream(filePath));
  });

  // Serve Angular index.html for any non-API route (hash routing — browser never sends fragment)
  app.setNotFoundHandler(async (_req, reply) => {
    return reply.sendFile('index.html');
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  app.get('/api/settings', async () => {
    return {
      defaultMemory: getSetting('defaultMemory') ?? '',
      defaultCpus: getSetting('defaultCpus') ?? '',
    };
  });

  app.post<{ Body: { defaultMemory?: string; defaultCpus?: string } }>(
    '/api/settings',
    async (req) => {
      const { defaultMemory, defaultCpus } = req.body;
      if (defaultMemory !== undefined) setSetting('defaultMemory', defaultMemory);
      if (defaultCpus !== undefined) setSetting('defaultCpus', defaultCpus);
      notifyStateChanged();
      return { ok: true };
    }
  );

  // ── Folder Mappings CRUD ──────────────────────────────────────────────────
  app.get('/api/folder-mappings', async () => listFolderMappings());

  app.post<{ Body: { name: string; host_path?: string; volume_name?: string; container_path: string; read_only?: number; enabled?: number; sort_order?: number } }>(
    '/api/folder-mappings',
    async (req) => {
      const { name, host_path = '', volume_name = '', container_path, read_only = 0, enabled = 1, sort_order = 0 } = req.body;
      if (!name || !container_path) throw new Error('name and container_path are required');
      const id = createFolderMapping({ name, host_path, volume_name, container_path, read_only, enabled, sort_order });
      notifyStateChanged();
      return { id };
    }
  );

  app.put<{ Params: { id: string }; Body: Partial<Omit<FolderMapping, 'id'>> }>(
    '/api/folder-mappings/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!getFolderMapping(id)) return reply.code(404).send({ error: 'not_found' });
      try {
        updateFolderMapping(id, req.body);
      } catch (err: any) {
        // Unknown column key (finding #9 fail-closed) → 400 instead of 500.
        return reply.code(400).send({ error: 'invalid_field', message: err.message });
      }
      notifyStateChanged();
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/folder-mappings/:id',
    async (req) => {
      deleteFolderMapping(Number(req.params.id));
      notifyStateChanged();
      return { ok: true };
    }
  );

  // ── Approved Host Ports (per container) ──────────────────────────────────────
  app.get<{ Params: { name: string } }>(
    '/api/containers/:name/ports',
    async (req) => listApprovedHostPorts(req.params.name)
  );

  app.post<{ Params: { name: string }; Body: { host_port: number; container_port?: number; protocol?: string; description?: string } }>(
    '/api/containers/:name/ports',
    async (req) => {
      const { host_port, container_port = 0, protocol = 'tcp', description = '' } = req.body;
      if (!host_port) throw new Error('host_port is required');
      const id = addApprovedHostPort({ container_id: req.params.name, host_port, container_port, protocol, description });
      notifyStateChanged();
      return { id };
    }
  );

  app.delete<{ Params: { name: string; id: string } }>(
    '/api/containers/:name/ports/:id',
    async (req) => {
      removeApprovedHostPort(Number(req.params.id));
      notifyStateChanged();
      return { ok: true };
    }
  );

  app.setErrorHandler((err: Error & { code?: string }, _req, reply) => {
    if (err.code === 'ERR_HTTP_HEADERS_SENT') {
      return;
    }
    if (!reply.sent) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Initialize (and log, if generated) the operator token before listen, so the
  // operator immediately knows what to log in with.
  getOperatorToken();

  const address = await app.listen({ port: API_PORT, host: '0.0.0.0' });
  console.log(`[api] listening on ${address}`);

  return app;
}
