import path from 'path';
import fs from 'fs';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Fastify, { FastifyInstance } from 'fastify';
import { stateEvents, notifyStateChanged } from './events';
import { runtimeEnv } from './runtime-env';
import fastifyStatic from '@fastify/static';
import { db, getAllGrants, setGrant, deleteGrant, getGrant, setActionPolicy, logAudit, getSudoGrant, getAirlocked, setAirlocked, listApprovedHostPorts, addApprovedHostPort, removeApprovedHostPort, ApprovedHostPort, listGroups, getGroup, getGroupByName, createGroup, updateGroup, deleteGroup, listIndexedFolders, countIndexedFolders, upsertIndexedFolder, deleteIndexedFolder, clearIndexedFolders, MAX_INDEXED_FOLDERS } from './db';
import {
  exportGroup,
  importGroupEnvelope,
  applyGroup,
  validateGroupEnvelope,
  reloadFirewallRulesFolder,
  syncGroupsToFolder,
} from './firewall-groups';
import {
  readHostConfig,
  setHostFolder,
  hostConfigAvailable,
  getResourceDefaults,
  setResourceDefaults,
  listFolderMappings,
  getFolderMapping,
  createFolderMapping,
  updateFolderMapping,
  deleteFolderMapping,
  toWireMapping,
  fromWirePatch,
} from './host-config';
import { containerPathError, defaultMultiMountWorkspace } from './workspace-root';
import { normalizeHostPath, hostPathError, hostPathLeaf } from './host-path';
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
import { sbxAvailable, startSandbox, sbxUpstreamUrl, SBX_PROXY_PORT, listSandboxes, removeSandbox, sshSetup, reconcile, trustCa, policyLogFor } from './sbx';
import { scheduleReconcile, ingestPending } from './sandbox/auto-sync';
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

const API_PORT = runtimeEnv.apiPort;
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

// The shareable subset of a rule (export/import, #69). Deliberately without the
// volatile columns (id/last_seen/request_count/created_at/updated_at).
interface ShareableRule {
  domain: string;
  container_id: string | null;
  status: RuleStatus;
  path_pattern: string | null;
  path_mode: number;
  expires_at: number | null;
}

export async function createApiServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // One access model for the entire management API: the operator token (auth.ts).
  // Source IP says nothing reliable here — Docker's proxy and Podman's
  // rootlessport rewrite the source to a bridge-gateway IP, and under
  // rootless Podman even which network that is changes per restart/disconnect
  // (GetRootlessPortChildIP iterates a map). Devcontainers, LAN and operator
  // can therefore only be separated by the token; the former subnet gate has
  // thus been replaced by auth on every /api/* route.
  //
  // Endpoints that devcontainers must be able to reach without a token (sudo-audit
  // ingest and the proxy CA). Keep this deliberately minimal: everything here is
  // callable by anyone on the network.
  const devcontainerPublicApi: Array<{ method: string; path: string }> = [
    { method: 'POST', path: '/api/audit/sudo' },
    { method: 'GET',  path: '/api/tls/ca.crt' },
  ];
  // Endpoints that the operator browser/CLI must be able to reach without a
  // logged-in session in order to be able to log in at all (and to see that
  // login is needed). The static SPA assets fall under this too (everything
  // outside /api/): it is only client code, and the API itself stays behind auth.
  const authPublicApi = new Set<string>(['/api/auth/login', '/api/auth/logout', '/api/auth/status']);

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0];
    if (!pathOnly.startsWith('/api/')) return;      // static SPA assets are free
    if (authPublicApi.has(pathOnly)) return;         // login/logout/status free
    if (devcontainerPublicApi.some(w => w.method === req.method && w.path === pathOnly)) return;
    if (!isAuthenticated(req.headers)) {
      reply.code(401).send({ error: 'unauthorized', reason: 'operator authentication required' });
    }
  });

  // Auto-sync (sbx mode): after any successful firewall-rule / group mutation, or
  // a sandbox lifecycle change, (re)project Huddle's rules into sbx policy.
  // Debounced + best-effort — a no-op when the sbx bridge isn't running.
  app.addHook('onResponse', async (req, reply) => {
    const m = req.method;
    if (m !== 'POST' && m !== 'PUT' && m !== 'DELETE') return;
    if (reply.statusCode >= 400) return;
    const p = (req.url ?? '').split('?')[0];
    if (/^\/api\/(rules|groups)\b/.test(p) || /^\/api\/sbx\/(start|sandboxes)\b/.test(p)) {
      scheduleReconcile(`${m} ${p}`);
    }
  });

  // ── Auth-endpoints ─────────────────────────────────────────────────────────
  // Login: check the token (constant-time) and on success set an httpOnly,
  // SameSite=Strict session cookie. SameSite=Strict is at once the
  // CSRF/CSWSH defense (finding #4): the browser does not send the cookie on
  // cross-site requests or WebSocket handshakes.
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
  // We keep it apart from the state-push wss so that lifecycle and error
  // handling do not get tangled up.
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

  // Multi-attach terminal (/ws/terminal/<container>): multiple clients share
  // the same Docker exec via the ptyManager. Eventually replaces /ws/exec.
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
    // Cross-Site WebSocket Hijacking (finding #4): a page that the operator
    // visits must not be able to open a WS to the portal. Two independent layers:
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
      // Only update path_pattern when the client explicitly sends it
      // (e.g. operator refines a requested sub-path while approving). Can hit the
      // unique index (domain, container, path) → 409 on a duplicate.
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

  // Toggle a domain in/out of path-allowlist mode. Operates on the host-only rule
  // (path_pattern IS NULL): when enabled the bare domain is set to 'deny' with
  // path_mode=1, so that unknown sub-paths are from then on raised as 'requested'
  // instead of being silently denied. Disabling restores it to a normal
  // host-only deny rule.
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
    // number/object in the JSON) would otherwise blow up further on with a 500
    // instead of this clean 400.
    if (typeof domain !== 'string' || !domain || !['requested', 'allow', 'deny'].includes(status)) {
      return reply.code(400).send({ error: 'invalid payload' });
    }
    // Store the domain as supplied — no casing mutation. The rule engine
    // already matches case-insensitively (COLLATE NOCASE in db.ts + canonicalizeHost/
    // matchDomain, finding #3), so lowercasing is redundant and would change the
    // echo-back to clients.
    try {
      const info = db
        .prepare(
          `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern) VALUES (?, ?, ?, ?, ?)`
        )
        .run(domain, container_id, status, expires_at, path_pattern);
      const inserted = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(info.lastInsertRowid) as Rule;
      // Only clean up the host-only requested row; per-domain path rules stay
      // in place so that fine-grained policy can coexist. COLLATE NOCASE:
      // requested rows are created lowercase (proxy/canonicalizeHost), so they
      // match even if the operator supplies mixed-case here.
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

  // ── Rules export / import (sharing rulesets, #69) ──────────────────────────
  // Only the shareable fields travel along; volatile columns (id/last_seen/
  // request_count/created_at) stay local. `container` filters by scope just like
  // GET /api/rules (one container or '__global__').
  const RULE_IMPORT_FIELDS = new Set(['domain', 'container_id', 'status', 'path_pattern', 'path_mode', 'expires_at']);

  // Validate one incoming rule fail-closed: unknown key → reject, and
  // check every field's type. Returns a normalized ShareableRule;
  // throws an Error with a usable message on invalid input.
  function validateImportRule(raw: unknown): ShareableRule {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('rule must be an object');
    }
    const r = raw as Record<string, unknown>;
    const unknown = Object.keys(r).filter((k) => !RULE_IMPORT_FIELDS.has(k));
    if (unknown.length > 0) throw new Error(`unknown field(s): ${unknown.join(', ')}`);
    if (typeof r.domain !== 'string' || !r.domain) throw new Error('domain must be a non-empty string');
    if (r.status !== 'requested' && r.status !== 'allow' && r.status !== 'deny') {
      throw new Error(`invalid status: ${String(r.status)}`);
    }
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

  app.get<{ Querystring: { container?: string } }>('/api/rules/export', async (req) => {
    const { container } = req.query;
    const where: string[] = [];
    const params: any[] = [];
    if (container) {
      if (container === '__global__') {
        where.push('container_id IS NULL');
      } else {
        where.push('container_id = ?');
        params.push(container);
      }
    }
    const sql =
      `SELECT domain, container_id, status, path_pattern, path_mode, expires_at FROM rules` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY domain COLLATE NOCASE, COALESCE(container_id, ''), COALESCE(path_pattern, '')`;
    const rules = db.prepare(sql).all(...params) as ShareableRule[];
    return { version: 1, exported_at: Math.floor(Date.now() / 1000), rules };
  });

  app.post<{
    Querystring: { container?: string };
    Body: { mode?: string; rules?: unknown; version?: number; exported_at?: number };
  }>('/api/rules/import', async (req, reply) => {
    const body = req.body ?? {};
    const mode = body.mode ?? 'merge';
    if (mode !== 'merge' && mode !== 'replace') {
      return reply.code(400).send({ error: 'mode must be "merge" or "replace"' });
    }
    if (!Array.isArray(body.rules)) {
      return reply.code(400).send({ error: 'rules must be an array' });
    }

    // Optional scope override: remap all imported rules to this container
    // ('__global__' → global). If the param is absent, each rule keeps its own
    // container_id from the document.
    const { container } = req.query;
    const scopeOverride =
      container === undefined ? undefined : container === '__global__' ? null : container;

    let parsed: ShareableRule[];
    try {
      parsed = body.rules.map(validateImportRule);
    } catch (err: any) {
      return reply.code(400).send({ error: 'invalid rule', message: err.message });
    }
    const effective =
      scopeOverride === undefined ? parsed : parsed.map((r) => ({ ...r, container_id: scopeOverride }));

    const findExisting = db.prepare(
      `SELECT id FROM rules
       WHERE domain = ? COLLATE NOCASE
         AND COALESCE(container_id, '') = COALESCE(?, '')
         AND COALESCE(path_pattern, '') = COALESCE(?, '')`
    );
    const insertRule = db.prepare(
      `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern, path_mode) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const updateRule = db.prepare(
      `UPDATE rules SET status = ?, expires_at = ?, path_mode = ?, updated_at = unixepoch() WHERE id = ?`
    );

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    const runImport = db.transaction(() => {
      if (mode === 'replace') {
        // 'replace' replaces exactly the scopes we are importing (global and/or
        // specific containers), not the whole table. When an explicit ?container
        // scope override is given, delete THAT scope even if the document is
        // empty — otherwise importing an empty ruleset to clear a scope would
        // delete nothing and 'replace' would silently fail open.
        const scopes: Set<string | null> =
          scopeOverride !== undefined
            ? new Set<string | null>([scopeOverride])
            : new Set<string | null>(effective.map((r) => r.container_id));
        for (const s of scopes) {
          if (s === null) db.prepare(`DELETE FROM rules WHERE container_id IS NULL`).run();
          else db.prepare(`DELETE FROM rules WHERE container_id = ?`).run(s);
        }
      }
      // In-batch dedupe on the unique key (domain NOCASE/container/path):
      // a second occurrence in the same document counts as 'skipped'.
      const seen = new Set<string>();
      for (const r of effective) {
        const key = `${r.domain.toLowerCase()} ${r.container_id ?? ''} ${r.path_pattern ?? ''}`;
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);

        const existing = findExisting.get(r.domain, r.container_id, r.path_pattern) as { id: number } | undefined;
        if (existing) {
          updateRule.run(r.status, r.expires_at, r.path_mode, existing.id);
          updated++;
        } else {
          insertRule.run(r.domain, r.container_id, r.status, r.expires_at, r.path_pattern, r.path_mode);
          imported++;
        }
      }
      // A path-scoped rule is inert over HTTPS unless its domain is in path-mode
      // (finding #6a): establish the host-only path_mode=1 marker for every
      // (domain, container) that received a path rule, exactly as the single-rule
      // create path does — otherwise imported path rules are denied at CONNECT.
      const markered = new Set<string>();
      for (const r of effective) {
        if (!r.path_pattern) continue;
        const mk = `${r.domain.toLowerCase()}\n${r.container_id ?? ''}`;
        if (markered.has(mk)) continue;
        markered.add(mk);
        ensurePathModeMarker(r.domain, r.container_id);
      }
    });

    try {
      runImport();
    } catch (err: any) {
      return reply.code(409).send({ error: 'import failed', message: err.message });
    }

    logAudit({
      containerId: scopeOverride ?? null,
      domain: 'firewall',
      action: `admin:rules-import-${mode}`,
      path: `imported=${imported} updated=${updated} skipped=${skipped}`,
    });
    notifyStateChanged();
    return { imported, updated, skipped };
  });

  // ── Firewall groups (#69) ──────────────────────────────────────────────────

  app.get('/api/groups', async () => listGroups());

  app.get<{ Params: { id: string } }>('/api/groups/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const group = getGroup(id);
    if (!group) return reply.code(404).send({ error: 'not_found' });
    const rules = db
      .prepare(
        `SELECT id, domain, container_id, status, expires_at, path_pattern, path_mode,
                last_path, group_id, added_by, source, created_at, updated_at, last_seen, request_count
           FROM rules WHERE group_id = ? ORDER BY last_seen DESC`,
      )
      .all(id) as Rule[];
    return { group, rules };
  });

  app.post<{ Body: { name?: string; description?: string; shared?: boolean } }>(
    '/api/groups',
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim();
      if (!name) return reply.code(400).send({ error: 'name is required' });
      if (getGroupByName(name)) return reply.code(409).send({ error: 'duplicate', message: 'a group with that name already exists' });
      const id = createGroup({ name, description: req.body?.description ?? '', shared: req.body?.shared ? 1 : 0 });
      logAudit({ containerId: null, domain: 'firewall', action: 'admin:group-create', path: `group=${name}` });
      notifyStateChanged();
      return getGroup(id);
    },
  );

  app.put<{ Params: { id: string }; Body: { name?: string; description?: string; shared?: boolean } }>(
    '/api/groups/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      const group = getGroup(id);
      if (!group) return reply.code(404).send({ error: 'not_found' });
      const patch: { name?: string; description?: string; shared?: number } = {};
      if (typeof req.body?.name === 'string') {
        const name = req.body.name.trim();
        if (!name) return reply.code(400).send({ error: 'name cannot be empty' });
        const clash = getGroupByName(name);
        if (clash && clash.id !== id) return reply.code(409).send({ error: 'duplicate' });
        patch.name = name;
      }
      if (typeof req.body?.description === 'string') patch.description = req.body.description;
      if (req.body?.shared !== undefined) patch.shared = req.body.shared ? 1 : 0;
      try {
        updateGroup(id, patch);
      } catch (err: any) {
        return reply.code(400).send({ error: 'invalid', message: err.message });
      }
      notifyStateChanged();
      return getGroup(id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/groups/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getGroup(id)) return reply.code(404).send({ error: 'not_found' });
    deleteGroup(id);
    logAudit({ containerId: null, domain: 'firewall', action: 'admin:group-delete', path: `group=${id}` });
    notifyStateChanged();
    return { ok: true };
  });

  // Assign an existing rule to the group (the `+` on a pending request).
  app.post<{ Params: { id: string }; Body: { rule_id?: number } }>(
    '/api/groups/:id/rules',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!getGroup(id)) return reply.code(404).send({ error: 'not_found' });
      const ruleId = Number(req.body?.rule_id);
      if (!Number.isInteger(ruleId)) return reply.code(400).send({ error: 'rule_id is required' });
      const rule = db.prepare(`SELECT id FROM rules WHERE id = ?`).get(ruleId);
      if (!rule) return reply.code(404).send({ error: 'rule_not_found' });
      db.prepare(`UPDATE rules SET group_id = ?, updated_at = unixepoch() WHERE id = ?`).run(id, ruleId);
      notifyStateChanged();
      return { ok: true };
    },
  );

  // Remove a rule from a group (clears group_id; the rule itself stays).
  app.delete<{ Params: { id: string; ruleId: string } }>(
    '/api/groups/:id/rules/:ruleId',
    async (req) => {
      const id = Number(req.params.id);
      const ruleId = Number(req.params.ruleId);
      db.prepare(`UPDATE rules SET group_id = NULL, updated_at = unixepoch() WHERE id = ? AND group_id = ?`).run(ruleId, id);
      notifyStateChanged();
      return { ok: true };
    },
  );

  // Apply the group's rules to a scope: global (container null/'__global__') or
  // a specific container.
  app.post<{ Params: { id: string }; Body: { container?: string | null } }>(
    '/api/groups/:id/apply',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!getGroup(id)) return reply.code(404).send({ error: 'not_found' });
      const raw = req.body?.container;
      const container = raw === undefined || raw === null || raw === '__global__' || raw === '' ? null : raw;
      const res = applyGroup(id, container);
      return { ok: true, ...res };
    },
  );

  app.get<{ Params: { id: string } }>('/api/groups/:id/export', async (req, reply) => {
    const env = exportGroup(Number(req.params.id));
    if (!env) return reply.code(404).send({ error: 'not_found' });
    return env;
  });

  app.post<{ Body: { mode?: string; envelope?: unknown } & Record<string, unknown> }>(
    '/api/groups/import',
    async (req, reply) => {
      const body = req.body ?? {};
      const mode = body.mode === 'replace' ? 'replace' : 'merge';
      // Accept either { mode, envelope: {...} } or a bare envelope in the body.
      const rawEnvelope = body.envelope ?? body;
      let env;
      try {
        env = validateGroupEnvelope(rawEnvelope);
      } catch (err: any) {
        return reply.code(400).send({ error: 'invalid envelope', message: err.message });
      }
      const res = importGroupEnvelope(env, { mode });
      return res;
    },
  );

  // Manual reload of the team-managed firewall-rules folder.
  app.post('/api/firewall-rules-folder/reload', async () => {
    return reloadFirewallRulesFolder();
  });

  // Write the portal's groups back out to the team-managed folder (app → files),
  // mirroring the current group set. Needs the folder mounted read-write; a
  // gateway started with the old read-only mount reports write errors until
  // `huddle restart` remounts it.
  app.post('/api/firewall-rules-folder/sync', async () => {
    return syncGroupsToFolder();
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

  // Reconnect huddle to a devcontainer's dc-net-<name> network.
  // Needed when a container recreates its network after a restart cycle;
  // huddle's old attachment is then stale and must be refreshed.
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

  // Huddle's MITM root-CA voor HTTPS-interceptie. Devcontainers downloaden dit
  // certificaat (via de whitelist) en installeren het in de system trust store.
  app.get('/api/tls/ca.crt', async (_req, reply) => {
    return reply
      .header('content-type', 'application/x-x509-ca-cert')
      .send(getCaCertPem());
  });

  app.post<{ Body: {
    imageName: string;
    workspaceDir?: string;
    mounts?: { hostPath: string; containerPath: string }[];
    containerWorkspace?: string;
    containerName: string;
    ideName?: string;
    empty?: boolean;
    presentableName?: string;
    memory?: string;
    cpus?: string;
  } }>(
    '/api/docker/start',
    async (req, reply) => {
      const { imageName, workspaceDir, mounts, containerWorkspace: containerWorkspaceOverride, containerName, ideName, empty, presentableName: presentableNameOverride, memory, cpus } = req.body;
      if (!imageName || !containerName) {
        return reply.code(400).send({ error: 'imageName and containerName required' });
      }
      if (workspaceDir && mounts?.length) {
        return reply.code(400).send({ error: 'Provide either workspaceDir or mounts, not both' });
      }
      if (!empty && !workspaceDir && !mounts?.length) {
        return reply.code(400).send({ error: 'workspaceDir or mounts required when empty is not set' });
      }
      // Each mount binds a host path at an explicit absolute container path; the
      // container paths must be unique so two folders never land on the same target.
      let normalizedMounts: { hostPath: string; containerPath: string }[] | undefined;
      if (mounts?.length) {
        try {
          const seen = new Set<string>();
          normalizedMounts = mounts.map((m) => {
            // Host paths go through the one normalizer (host-path.ts): the value
            // may be typed in the modal, picked from the folder index or sent by
            // the CLI, and on Windows all three spell the same folder
            // differently (`T:\p`, `t:/p/`, `T:/p`).
            const hostPath = normalizeHostPath(m.hostPath ?? '');
            const containerPath = (m.containerPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
            const hostProblem = hostPathError(hostPath);
            if (hostProblem) throw new Error(`Host path ${hostProblem}: "${m.hostPath ?? ''}"`);
            const pathProblem = containerPathError(containerPath);
            if (pathProblem) throw new Error(`Container path ${pathProblem}: "${m.containerPath}"`);
            if (seen.has(containerPath)) throw new Error(`Duplicate container path: ${containerPath}`);
            seen.add(containerPath);
            return { hostPath, containerPath };
          });
        } catch (err: any) {
          return reply.code(400).send({ error: err.message });
        }
      }
      const fwd = normalizeHostPath(workspaceDir ?? '');
      if (!empty && !normalizedMounts) {
        const problem = hostPathError(fwd);
        if (problem) return reply.code(400).send({ error: `workspaceDir ${problem}: "${workspaceDir ?? ''}"` });
      }
      const leaf = empty
        ? containerName.replace(/^devcontainer-/, '') || containerName
        : normalizedMounts
          ? (normalizedMounts[0].containerPath.split('/').filter(Boolean).pop() ?? containerName)
          : (fwd.split('/').pop() ?? containerName);
      // Multi-mount: the IDE opens the explicit "open at" root chosen in the modal.
      // Fall back to the deepest common parent of the container paths (else /workspaces)
      // when no override is supplied (e.g. an older CLI).
      let multiWorkspace = (containerWorkspaceOverride ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalizedMounts && !multiWorkspace) {
        multiWorkspace = defaultMultiMountWorkspace(normalizedMounts.map((m) => m.containerPath));
      }
      // Single choke point for the value that reaches the container setup script:
      // whether it came from the caller's explicit "open at" override, from the
      // common parent of the mounts, or from the single-mount leaf, it is checked
      // here before createAndStartContainer() interpolates it into a script that
      // runs as root inside the new container.
      const containerWorkspace = normalizedMounts ? multiWorkspace : `/workspaces/${leaf}`;
      const workspaceProblem = containerPathError(containerWorkspace);
      if (workspaceProblem) {
        return reply.code(400).send({ error: `containerWorkspace ${workspaceProblem}: "${containerWorkspace}"` });
      }
      const ide: IdeName = isIdeName(ideName) ? ideName : 'intellij';
      const params: StartParams = {
        imageName,
        workspaceDir: empty ? '' : fwd,
        mounts: normalizedMounts,
        containerName,
        containerWorkspace,
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

  // ── Docker Sandboxes (sbx) — experimental second box type ─────────────────
  // Start a microVM sandbox with Huddle as its upstream proxy. Minimal MVP:
  // status tells the portal whether sbx is usable + which upstream/port Huddle
  // exposes; start sets the upstream proxy and creates the sandbox, returning the
  // per-step output so the first wall is visible in the UI.
  app.get('/api/sbx/status', async () => {
    const avail = await sbxAvailable();
    return { ...avail, upstreamUrl: sbxUpstreamUrl(), proxyPort: SBX_PROXY_PORT };
  });

  app.post<{ Body: { name?: string; agent?: string; workspace?: string } }>(
    '/api/sbx/start',
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim() || `huddle-sbx-${Date.now().toString(36)}`;
      // Sandbox names feed a no-shell execFile arg, but keep them tame anyway.
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
        return reply.code(400).send({ error: 'invalid sandbox name' });
      }
      const agent = typeof req.body?.agent === 'string' ? req.body.agent.trim() : undefined;
      const workspace = typeof req.body?.workspace === 'string' ? req.body.workspace.trim() : undefined;
      try {
        const result = await startSandbox({ name, agent: agent || undefined, workspace: workspace || undefined });
        logAudit({ containerId: null, domain: '-', action: `admin:sbx-start${result.ok ? '' : '-failed'}` });
        return { name, ...result };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // List the sandboxes the host sbx daemon currently knows about.
  app.get('/api/sbx/sandboxes', async (_req, reply) => {
    try {
      return { sandboxes: await listSandboxes() };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // Remove a sandbox (host-side `sbx rm [--force] <name>`).
  app.delete<{ Params: { name: string }; Querystring: { force?: string } }>(
    '/api/sbx/sandboxes/:name',
    async (req, reply) => {
      const name = req.params.name;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
        return reply.code(400).send({ error: 'invalid sandbox name' });
      }
      const force = req.query?.force === '1' || req.query?.force === 'true';
      try {
        const exitCode = await removeSandbox(name, force);
        logAudit({ containerId: null, domain: '-', action: `admin:sbx-rm${exitCode === 0 ? '' : '-failed'}` });
        return { name, exitCode, ok: exitCode === 0 };
      } catch (err: any) {
        return reply.code(502).send({ error: err.message });
      }
    }
  );

  // Raw sbx policy log + parsed denied entries — diagnostics for the pending
  // ingest (so we can see exactly what `sbx policy log --json` returns).
  app.get<{ Params: { name: string } }>('/api/sbx/sandboxes/:name/log', async (req, reply) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) return reply.code(400).send({ error: 'invalid sandbox name' });
    try {
      return await policyLogFor(name);
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // Run the sbx → Huddle pending ingest on demand (also runs on a poller).
  app.post('/api/sbx/ingest', async (_req, reply) => {
    try {
      return { added: await ingestPending() };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // Install Huddle's CA into a sandbox so HTTPS through the MITM proxy is trusted
  // (fixes JetBrains/VS Code backend downloads: curl "unable to get local issuer").
  app.post<{ Params: { name: string } }>('/api/sbx/sandboxes/:name/trust-ca', async (req, reply) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      return reply.code(400).send({ error: 'invalid sandbox name' });
    }
    try {
      const step = await trustCa(name);
      logAudit({ containerId: null, domain: '-', action: `admin:sbx-trust-ca${step.code === 0 ? '' : '-failed'}` });
      return { name, ...step, ok: step.code === 0 };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // One-time SSH bridge setup so sandboxes are reachable at <name>.sbx for
  // VS Code / JetBrains remote development (host-side `sbx setup ssh`).
  app.post('/api/sbx/ssh-setup', async (_req, reply) => {
    try {
      const exitCode = await sshSetup();
      logAudit({ containerId: null, domain: '-', action: `admin:sbx-ssh-setup${exitCode === 0 ? '' : '-failed'}` });
      return { exitCode, ok: exitCode === 0 };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // Reconcile Huddle's rules into sbx policy (one-way, Huddle = truth). Pass
  // ?dryRun=1 to preview the projection without mutating sbx. Returns a full
  // report incl. path rules that sbx cannot express (enforced at Huddle's proxy).
  app.post<{ Querystring: { dryRun?: string } }>('/api/sbx/reconcile', async (req, reply) => {
    const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
    try {
      const report = await reconcile({ dryRun });
      logAudit({ containerId: null, domain: '-', action: `admin:sbx-reconcile${report.ok ? '' : '-partial'}` });
      return report;
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

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

  // ── Fine-grained Docker action permissions ────────────────────────────────

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
  // The Angular UI sends uncaught runtime errors here so that they are visible
  // in `docker logs huddle`. Only log, persist nothing.

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
  // The 'noot' admin user starts LOCKED without a password. Admin access is
  // from now on temporary: a grant sets a FRESH password in the container, unlocks
  // the account for `minutes` minutes, and returns the password EXACTLY ONCE.
  // On expiry (sweeper) or revocation the account is locked again. No
  // (plaintext or hashed) password is stored (finding #10).

  // Status: is there an active grant and until when? NEVER returns a (reusable)
  // password — replaces the old /credentials endpoint.
  app.get<{ Params: { name: string } }>('/api/docker/containers/:name/sudo-grant', async (req) => {
    const grant = getSudoGrant(req.params.name);
    const now = Math.floor(Date.now() / 1000);
    const active = !!grant && grant.until > now;
    return { active, until: active ? grant!.until : null };
  });

  // Grant admin access: generate a password, set+unlock in the container, store the
  // grant and return the password once. Fail closed: if the exec fails,
  // no grant is stored and a 500 follows.
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

  // Revoke admin access immediately: lock 'noot' and remove the grant.
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
  // Catch-all for extension API routes. Must come BEFORE loadAllExtensions()
  // so that it is registered before listen() — extensions write to
  // extDispatch instead of setting routes directly on Fastify.
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

  // Load team-managed firewall rules from the CLI-mounted folder at startup
  // (#69). The CLI binds the configured host folder to FIREWALL_RULES_MOUNT;
  // no-op when nothing is mounted there. Best-effort: the live folder status
  // (mounted, group/rule/error counts) is surfaced on demand via the
  // firewall-rules-folder endpoint, so startup does not print it.
  try {
    reloadFirewallRulesFolder();
  } catch (err) {
    // best-effort startup load; the live folder status is also surfaced on demand
    // via the folder-status endpoint, but surface the failure in the logs too.
    console.warn(`[firewall] startup folder reload failed: ${(err as Error).message}`);
  }

  // Serve an extension's static frontend assets from
  // <EXT_DIR>/<id>/frontend/. The resolved path must stay within that folder,
  // otherwise it is a traversal attempt (e.g. ../../).
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
    // Every setting on this page lives in the CLI config (~/.huddle/config.json),
    // mounted read-write into the gateway (#69/#98) — not in the SQLite DB. That
    // makes the config file the single source of truth the team can review and
    // hand-edit.
    const host = readHostConfig();
    const resources = getResourceDefaults();
    return {
      defaultMemory: resources.defaultMemory,
      defaultCpus: resources.defaultCpus,
      extensionsFolder: host.extensionsFolder ?? '',
      firewallRulesFolder: host.firewallRulesFolder ?? '',
      // Whether the CLI config is actually mounted; the portal warns if not.
      hostConfigMounted: hostConfigAvailable(),
    };
  });

  app.post<{ Body: { defaultMemory?: string; defaultCpus?: string; extensionsFolder?: string; firewallRulesFolder?: string } }>(
    '/api/settings',
    async (req, reply) => {
      const { defaultMemory, defaultCpus, extensionsFolder, firewallRulesFolder } = req.body;
      let restartRequired = false;
      let persisted = true;
      // Resource limits go into the same config file, but need no remount: the
      // gateway reads them when it creates the next devcontainer (#98).
      if (defaultMemory !== undefined || defaultCpus !== undefined) {
        persisted = setResourceDefaults({ defaultMemory, defaultCpus }) && persisted;
      }
      // Folder paths are written into the mounted CLI config. They only take
      // effect after the CLI re-mounts them, so signal that a restart is needed.
      // `huddle init` passes them to the engine as a `-v` argument WITHOUT a
      // shell, so they get the same normalizer as every other host path: one
      // notation in the config file, and no `~` that nothing would expand.
      for (const [key, raw] of [['extensionsFolder', extensionsFolder], ['firewallRulesFolder', firewallRulesFolder]] as const) {
        if (raw === undefined) continue;
        const folder = normalizeHostPath(raw);
        const problem = folder ? hostPathError(folder) : null;   // empty clears the setting
        if (problem) return reply.code(400).send({ error: 'invalid_host_path', message: `${key} ${problem}` });
        persisted = setHostFolder(key, folder) && persisted;
        restartRequired = true;
      }
      notifyStateChanged();
      return { ok: true, restartRequired, persisted };
    }
  );

  // ── Folder Mappings CRUD ──────────────────────────────────────────────────
  // Backed by the mounted CLI config (~/.huddle/config.json), not the DB (#98).
  // The wire shape is unchanged (snake_case, 0/1 flags) so the portal is
  // unaffected by where the mappings are stored.
  app.get('/api/folder-mappings', async () => listFolderMappings().map(toWireMapping));

  app.post<{ Body: { name: string; host_path?: string; volume_name?: string; container_path: string; read_only?: number; enabled?: number; sort_order?: number } }>(
    '/api/folder-mappings',
    async (req, reply) => {
      const { name, host_path = '', volume_name = '', container_path, read_only = 0, enabled = 1, sort_order = 0 } = req.body;
      if (!name || !container_path) throw new Error('name and container_path are required');
      if (!hostConfigAvailable()) return reply.code(503).send({ error: 'config_not_mounted' });
      // A mapping's host path is mounted into every devcontainer, so it goes
      // through the same normalizer as a workspace path: stored one way, and on
      // Windows translated to the engine's prefix at container-create time.
      const hostPath = normalizeHostPath(host_path);
      if (hostPath) {
        const problem = hostPathError(hostPath);
        if (problem) return reply.code(400).send({ error: 'invalid_host_path', message: `host_path ${problem}` });
      }
      const id = createFolderMapping({
        name,
        hostPath,
        volumeName: volume_name,
        containerPath: container_path,
        readOnly: read_only === 1,
        enabled: enabled === 1,
        sortOrder: sort_order,
      });
      if (id === null) return reply.code(500).send({ error: 'config_write_failed' });
      notifyStateChanged();
      return { id };
    }
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/folder-mappings/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!getFolderMapping(id)) return reply.code(404).send({ error: 'not_found' });
      let patch;
      try {
        patch = fromWirePatch(req.body);
      } catch (err: any) {
        // Unknown field (fail-closed, finding #9) → 400 instead of 500.
        return reply.code(400).send({ error: 'invalid_field', message: err.message });
      }
      if (patch.hostPath !== undefined) {
        patch.hostPath = normalizeHostPath(patch.hostPath);
        const problem = patch.hostPath ? hostPathError(patch.hostPath) : null;
        if (problem) return reply.code(400).send({ error: 'invalid_host_path', message: `host_path ${problem}` });
      }
      if (!updateFolderMapping(id, patch)) return reply.code(500).send({ error: 'config_write_failed' });
      notifyStateChanged();
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/folder-mappings/:id',
    async (req, reply) => {
      if (!deleteFolderMapping(Number(req.params.id))) {
        return reply.code(500).send({ error: 'config_write_failed' });
      }
      notifyStateChanged();
      return { ok: true };
    }
  );

  // ── Indexed host folders ──────────────────────────────────────────────────
  // Huddle's portal runs in a container: it cannot open a file dialog on the
  // host, so a host path has always had to be typed from memory. `huddle
  // indexfolder` walks the host once and posts what it found here; the portal
  // then offers those folders wherever a host path is needed. Operators can also
  // add or remove single entries from Settings.
  app.get('/api/indexed-folders', async () => ({
    folders: listIndexedFolders(),
    max: MAX_INDEXED_FOLDERS,
  }));

  app.post<{ Body: { path?: string; paths?: string[]; root?: string; source?: string; replace?: boolean } }>(
    '/api/indexed-folders',
    async (req, reply) => {
      const { path: single, paths, root, source, replace } = req.body ?? {};
      const raw = [...(Array.isArray(paths) ? paths : []), ...(single ? [single] : [])];
      if (raw.length === 0) return reply.code(400).send({ error: 'no_paths' });
      // 'cli' when a scan posted the batch, 'manual' when an operator typed one
      // entry in Settings — the portal shows which is which, and re-running the
      // scan must not silently relabel a hand-added folder as machine-found.
      const src = source === 'manual' ? 'manual' : 'cli';

      // Replace is scoped to the subtree that was just re-scanned, so indexing
      // one project again never discards folders indexed from anywhere else.
      // Without a usable root there is no subtree to scope to, and falling back
      // to "clear everything" would turn a re-index of one project into total
      // index loss. Refuse instead — wiping the index is the DELETE endpoint's
      // job, and that one is explicit about it.
      const normalizedRoot = root ? normalizeHostPath(root) : '';
      if (replace && !normalizedRoot) {
        return reply.code(400).send({ error: 'root_required', message: 'replace requires a non-empty root' });
      }
      let removed = 0;
      if (replace) removed = clearIndexedFolders(normalizedRoot);

      let added = 0;
      let updated = 0;
      let skipped = 0;
      const invalid: { path: string; error: string }[] = [];
      // Dedupe inside the batch too: the caller may well send two spellings of
      // the same folder, and 'skipped' should not depend on insertion order.
      const seen = new Set<string>();
      let total = countIndexedFolders();
      for (const candidate of raw) {
        if (typeof candidate !== 'string') { invalid.push({ path: String(candidate), error: 'must be a string' }); continue; }
        const normalized = normalizeHostPath(candidate);
        const err = hostPathError(normalized);
        if (err) { invalid.push({ path: candidate, error: err }); continue; }
        const key = normalized.toLowerCase();
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);
        if (total >= MAX_INDEXED_FOLDERS) { skipped++; continue; }
        const result = upsertIndexedFolder({ path: normalized, label: hostPathLeaf(normalized), source: src });
        if (result === 'added') { added++; total++; } else { updated++; }
      }
      notifyStateChanged();
      return { added, updated, skipped, removed, invalid, total, max: MAX_INDEXED_FOLDERS };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/indexed-folders/:id',
    async (req) => {
      deleteIndexedFolder(Number(req.params.id));
      notifyStateChanged();
      return { ok: true };
    }
  );

  // Clearing the whole index (or one subtree) is a separate, explicit call so a
  // malformed single-entry delete can never wipe the list.
  app.delete<{ Querystring: { root?: string } }>(
    '/api/indexed-folders',
    async (req) => {
      const root = req.query?.root ? normalizeHostPath(req.query.root) : undefined;
      const removed = clearIndexedFolders(root);
      notifyStateChanged();
      return { removed };
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

  // Initialize (and log, if generated) the operator token before listen,
  // so that the operator immediately knows what to log in with.
  getOperatorToken();

  const address = await app.listen({ port: API_PORT, host: '0.0.0.0' });
  console.log(`[api] listening on ${address}`);

  return app;
}
