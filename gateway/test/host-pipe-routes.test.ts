import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EnvironmentProvider, SandboxInfo } from '../src/environments/types';

// De HTTP-routes rond de host pipe (docs/host-pipe.md), met een nep-pipe en een
// nep-provider op een kale Fastify — createApiServer() bindt een poort en raakt
// Docker aan. De sandboxes-tabel draait op de in-memory DB.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[host-pipe-routes.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`);
}

let app: FastifyInstance;
let db: typeof import('../src/db');
let HostPipeError: typeof import('../src/host-pipe').HostPipeError;
let ToolFailedError: typeof import('../src/environments/types').ToolFailedError;
let ProviderDisabledError: typeof import('../src/environments/types').ProviderDisabledError;

// Per test in te stellen gedrag
let pipeCall: (op: string, args: any) => Promise<any>;
let pipeStatus: () => any;
let existing: SandboxInfo[];
let removeImpl: (name: string, opts: { force: boolean }) => Promise<void>;
const removed: { name: string; force: boolean }[] = [];
let enabled = true;
const recreates: string[] = [];

const fake: EnvironmentProvider = {
  id: 'fake',
  label: 'Fake',
  status: async () => ({ id: 'fake', label: 'Fake', enabled, available: true, version: '1', agents: ['a'] }),
  list: async () => {
    if (!enabled) throw new ProviderDisabledError('off');
    return existing;
  },
  isEnabled: () => enabled,
  setEnabled: async (on) => {
    enabled = on;
    return [{ label: 'Toggle', command: 'fake toggle', code: 0, stdout: '', stderr: '' }];
  },
  recreateAll: async (reason) => {
    recreates.push(reason);
    return { running: true, reason, startedAt: 'now', results: [] };
  },
  create: async (spec) => ({
    name: spec.name || 'gen-1',
    ok: spec.agent !== 'fail',
    steps: [{ label: 'Create sandbox', command: 'fake create', code: spec.agent === 'fail' ? 1 : 0, stdout: '', stderr: '' }],
  }),
  remove: (name, opts) => removeImpl(name, opts),
};

describe.skipIf(!sqliteAvailable)('host pipe routes', () => {
  beforeAll(async () => {
    db = await import('../src/db');
    db.initDb();
    ({ HostPipeError } = await import('../src/host-pipe'));
    ({ ToolFailedError, ProviderDisabledError } = await import('../src/environments/types'));
    const { registerHostPipeRoutes } = await import('../src/host-pipe-routes');
    const Fastify = (await import('fastify')).default;
    app = Fastify({ logger: false });
    registerHostPipeRoutes(app, {
      pipe: { call: (op: string, args: any) => pipeCall(op, args), status: () => pipeStatus() } as any,
      getProvider: (id) => (id === 'fake' ? fake : undefined),
      listProviders: () => [fake],
    });
    await app.ready();
    // Ruim: fastify + better-sqlite3 importeren duurt op een drukke devcontainer
    // soms langer dan de standaard 10 s hook-timeout.
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  beforeEach(() => {
    db.db.exec('DELETE FROM sandboxes');
    removed.length = 0;
    recreates.length = 0;
    enabled = true;
    existing = [];
    pipeCall = async () => ({ path: '', folders: [], truncated: false, max: 2000 });
    pipeStatus = () => ({ online: true, version: '1.2.3', platform: 'linux', tools: ['sbx'], updatedAt: 'x' });
    removeImpl = async (name, opts) => { removed.push({ name, ...opts }); };
  });

  it('initDb ruimt de oude indexed_folders-tabel op', () => {
    db.db.exec('CREATE TABLE IF NOT EXISTS indexed_folders (id INTEGER)');
    db.initDb();
    const t = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_folders'").get();
    expect(t).toBeUndefined();
  });

  it('GET /api/host-pipe geeft de heartbeat-status', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/host-pipe' });
    expect(r.json()).toEqual({ online: true, version: '1.2.3', platform: 'linux', tools: ['sbx'], updatedAt: 'x' });
  });

  describe('GET /api/host-folders', () => {
    it('zonder path → roots (fs.list zonder path)', async () => {
      let seen: any;
      pipeCall = async (op, args) => { seen = { op, args }; return { path: '', folders: [{ path: '/', name: '/' }], truncated: false, max: 2000 }; };
      const r = await app.inject({ method: 'GET', url: '/api/host-folders' });
      expect(r.statusCode).toBe(200);
      expect(seen).toEqual({ op: 'fs.list', args: {} });
      expect(r.json().folders).toEqual([{ path: '/', name: '/' }]);
    });

    it('normaliseert het pad voor de host', async () => {
      let seen: any;
      pipeCall = async (_op, args) => { seen = args; return { path: 'T:/x', folders: [], truncated: false, max: 2000 }; };
      await app.inject({ method: 'GET', url: '/api/host-folders?path=' + encodeURIComponent('t:\\x\\') });
      expect(seen).toEqual({ path: 'T:/x' });
    });

    it('400 op een ongeldig pad, zonder de host te vragen', async () => {
      pipeCall = async () => { throw new Error('should not be called'); };
      const r = await app.inject({ method: 'GET', url: '/api/host-folders?path=relative/x' });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('invalid_path');
    });

    it('503 offline, 404 not_found', async () => {
      pipeCall = async () => { throw new HostPipeError('host_pipe_offline', 'down'); };
      let r = await app.inject({ method: 'GET', url: '/api/host-folders' });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe('host_pipe_offline');
      pipeCall = async () => { throw new HostPipeError('not_found', 'gone'); };
      r = await app.inject({ method: 'GET', url: '/api/host-folders?path=/gone' });
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe('not_found');
    });
  });

  it('GET /api/environments geeft provider-status; offline → 503', async () => {
    let r = await app.inject({ method: 'GET', url: '/api/environments' });
    expect(r.json()).toEqual({ providers: [{ id: 'fake', label: 'Fake', enabled: true, available: true, version: '1', agents: ['a'] }] });
    const orig = fake.status;
    fake.status = async () => { throw new HostPipeError('host_pipe_offline'); };
    r = await app.inject({ method: 'GET', url: '/api/environments' });
    fake.status = orig;
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('host_pipe_offline');
  });

  it('onbekende provider → 404', async () => {
    for (const [method, url] of [
      ['GET', '/api/environments/nope/sandboxes'],
      ['POST', '/api/environments/nope/sandboxes'],
      ['DELETE', '/api/environments/nope/sandboxes/x'],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode).toBe(404);
    }
  });

  it('POST maakt aan en registreert; GET markeert managed', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/environments/fake/sandboxes',
      payload: { agent: 'a', workspaces: [{ path: '/x', readOnly: false }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ name: 'gen-1', ok: true, steps: [{ label: 'Create sandbox' }] });
    expect(db.hasSandbox('fake', 'gen-1')).toBe(true);

    existing = [{ name: 'gen-1', provider: 'fake' }, { name: 'handmade', provider: 'fake' }];
    const list = await app.inject({ method: 'GET', url: '/api/environments/fake/sandboxes' });
    expect(list.json()).toEqual({
      sandboxes: [
        { name: 'gen-1', provider: 'fake', managed: true },
        { name: 'handmade', provider: 'fake', managed: false },
      ],
    });
  });

  it('GET vergeet records van verdwenen sandboxes, zodat een hergebruikte naam niet managed wordt', async () => {
    db.db.prepare('INSERT INTO sandboxes (provider, name, created_at) VALUES (?, ?, unixepoch() - 60)').run('fake', 'gone');
    db.recordSandbox('fake', 'just-made'); // net aangemaakt: mag nog ontbreken in een lopende list
    existing = [];
    await app.inject({ method: 'GET', url: '/api/environments/fake/sandboxes' });
    expect(db.hasSandbox('fake', 'gone')).toBe(false);
    expect(db.hasSandbox('fake', 'just-made')).toBe(true);

    existing = [{ name: 'gone', provider: 'fake' }];
    const list = await app.inject({ method: 'GET', url: '/api/environments/fake/sandboxes' });
    expect(list.json().sandboxes).toEqual([{ name: 'gone', provider: 'fake', managed: false }]);
  });

  it('POST: mislukte create wordt niet geregistreerd; ontbrekende velden → 400', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/environments/fake/sandboxes',
      payload: { name: 'x', agent: 'fail', workspaces: [{ path: '/x' }] },
    });
    expect(r.json().ok).toBe(false);
    expect(db.hasSandbox('fake', 'x')).toBe(false);
    const bad = await app.inject({ method: 'POST', url: '/api/environments/fake/sandboxes', payload: { workspaces: [] } });
    expect(bad.statusCode).toBe(400);
  });

  it('DELETE: 404 als Huddle hem niet maakte', async () => {
    existing = [{ name: 'handmade', provider: 'fake' }];
    const r = await app.inject({ method: 'DELETE', url: '/api/environments/fake/sandboxes/handmade' });
    expect(r.statusCode).toBe(404);
    expect(removed).toEqual([]);
  });

  it('DELETE ?force=1: verwijdert en vergeet het record', async () => {
    db.recordSandbox('fake', 'mine');
    const r = await app.inject({ method: 'DELETE', url: '/api/environments/fake/sandboxes/mine?force=1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(removed).toEqual([{ name: 'mine', force: true }]);
    expect(db.hasSandbox('fake', 'mine')).toBe(false);
  });

  it('DELETE: rm faalt maar de sandbox bestaat nog → 502 en record blijft', async () => {
    db.recordSandbox('fake', 'mine');
    existing = [{ name: 'mine', provider: 'fake' }];
    removeImpl = async () => { throw new ToolFailedError('busy', 1); };
    const r = await app.inject({ method: 'DELETE', url: '/api/environments/fake/sandboxes/mine' });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'tool_failed', message: 'busy' });
    expect(db.hasSandbox('fake', 'mine')).toBe(true);
  });

  it('DELETE: rm faalt omdat hij al weg is → record opgeruimd', async () => {
    db.recordSandbox('fake', 'mine');
    removeImpl = async () => { throw new ToolFailedError('no such sandbox', 1); };
    const r = await app.inject({ method: 'DELETE', url: '/api/environments/fake/sandboxes/mine' });
    expect(r.statusCode).toBe(200);
    expect(db.hasSandbox('fake', 'mine')).toBe(false);
  });

  it('DELETE: pipe offline → 503, record blijft', async () => {
    db.recordSandbox('fake', 'mine');
    removeImpl = async () => { throw new HostPipeError('host_pipe_offline'); };
    const r = await app.inject({ method: 'DELETE', url: '/api/environments/fake/sandboxes/mine' });
    expect(r.statusCode).toBe(503);
    expect(db.hasSandbox('fake', 'mine')).toBe(true);
  });

  it('PUT /api/environments/:provider zet aan/uit, met audit; ongeldige body → 400', async () => {
    let r = await app.inject({ method: 'PUT', url: '/api/environments/fake', payload: { enabled: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ enabled: false, steps: [{ label: 'Toggle' }] });
    const audit = db.db.prepare(`SELECT action FROM audit_log WHERE domain = 'fake' ORDER BY id DESC LIMIT 1`).get() as any;
    expect(audit.action).toBe('admin:provider-disable');
    r = await app.inject({ method: 'PUT', url: '/api/environments/fake', payload: { enabled: 'yes' } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'PUT', url: '/api/environments/nope', payload: { enabled: true } });
    expect(r.statusCode).toBe(404);
  });

  it('uitgeschakelde provider → 409 provider_disabled', async () => {
    enabled = false;
    const r = await app.inject({ method: 'GET', url: '/api/environments/fake/sandboxes' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('provider_disabled');
  });

  it('POST /api/environments/:provider/recreate start een recreate', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/environments/fake/recreate' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ running: true });
    expect(recreates).toEqual(['requested in the portal']);
  });
});
