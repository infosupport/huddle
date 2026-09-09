import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Same mocking pattern as docker-create-rollback.test.ts: createAndStartContainer
// touches db.ts (registerSocketName/unregisterSocketNameIfCurrent) and, via
// socket-proxy.ts, more of db.ts's read-only surface.
const dbCalls = { registered: [] as string[], unregistered: [] as { name: string; revision: string }[] };
let nextRevision = 0;
vi.mock('../src/db', () => ({
  isHostPortApproved: () => false,
  getActionPolicy: () => null,
  getGrant: () => null,
  registerSocketName: (name: string) => {
    dbCalls.registered.push(name);
    return `rev-${++nextRevision}`;
  },
  unregisterSocketNameIfCurrent: (name: string, revision: string) => { dbCalls.unregistered.push({ name, revision }); },
}));

vi.mock('../src/events', () => ({ notifyStateChanged: () => {} }));

vi.mock('../src/socket-registration', () => ({
  waitForSocketReadiness: async () => true,
}));

// createAndStartContainer reads the real CA to bake into the config script;
// tls-ca.ts requires initCa() to have run first (nothing in this file needs a
// real cert), so it's stubbed the same way the rest of the Docker-facing
// surface here is.
vi.mock('../src/tls-ca', () => ({
  getCaCertPem: () => '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
}));

// Captures every POST /containers/create body so tests can assert on the Env
// array Huddle actually sends to Docker — the rest of the Docker API surface
// createAndStartContainer touches on a full success path is faked with
// minimal, always-succeeding responses.
const captured: { createBody?: any } = {};
vi.mock('http', () => ({
  default: {
    request: (opts: { method: string; path: string }, cb: (res: EventEmitter & { statusCode: number }) => void) => {
      const { method, path } = opts;
      let statusCode = 200;
      let body = '{}';

      if (method === 'GET' && /^\/containers\/.+\/json$/.test(path)) { statusCode = 404; body = 'no such container'; }
      else if (method === 'GET' && /^\/networks\//.test(path)) { statusCode = 404; body = 'network not found'; }
      else if (method === 'GET' && /^\/images\/.+\/json$/.test(path)) { statusCode = 200; body = '{}'; }
      else if (method === 'GET' && path === '/info') { statusCode = 200; body = '{}'; }
      else if (method === 'POST' && /^\/containers\/create/.test(path)) { statusCode = 200; body = '{"Id":"deadbeef"}'; }
      else if (method === 'POST' && /^\/containers\/.+\/start$/.test(path)) { statusCode = 200; body = '{}'; }
      else if (method === 'POST' && /^\/containers\/.+\/exec$/.test(path)) { statusCode = 200; body = '{"Id":"exec1"}'; }
      else if (method === 'POST' && /^\/exec\/.+\/start$/.test(path)) { statusCode = 200; body = '{}'; }
      else if (method === 'POST' && /^\/networks\/create$/.test(path)) { statusCode = 200; body = '{}'; }
      else if (method === 'POST' && /^\/networks\/.+\/connect$/.test(path)) { statusCode = 200; body = '{}'; }

      const res = Object.assign(new EventEmitter(), { statusCode });
      const req = new EventEmitter() as EventEmitter & { write: (chunk: any) => void; end: () => void };
      let written = '';
      req.write = (chunk: any) => { written += chunk; };
      req.end = () => {
        if (method === 'POST' && /^\/containers\/create/.test(path) && written) {
          try { captured.createBody = JSON.parse(written); } catch { /* ignore */ }
        }
        queueMicrotask(() => {
          cb(res);
          res.emit('data', body);
          res.emit('end');
        });
      };
      return req;
    },
  },
}));

const { createAndStartContainer, buildJbConfigScript, buildVscodeConfigScript } = await import('../src/docker');

describe('createAndStartContainer — reserved env-name filtering', () => {
  beforeEach(() => {
    dbCalls.registered.length = 0;
    dbCalls.unregistered.length = 0;
    nextRevision = 0;
    captured.createBody = undefined;
  });

  it('drops a containerEnv entry named http_proxy and reports it in ignoredEnv', async () => {
    const result = await createAndStartContainer({
      imageName: 'ghcr.io/infosupport/base-devimage-vscode',
      workspaceDir: '',
      containerName: 'dc-env-reserved',
      containerWorkspace: '/workspaces/project',
      presentableName: 'project',
      ideName: 'vscode',
      empty: true,
      containerEnv: { http_proxy: 'http://attacker:8080', MY_VAR: 'hello' },
    });

    expect(result.ignoredEnv).toEqual(['http_proxy']);
    const env: string[] = captured.createBody.Env;
    expect(env).not.toContain('http_proxy=http://attacker:8080');
    // Huddle's own http_proxy must still be present and untouched.
    expect(env).toContain('http_proxy=http://huddle:80');
  });

  it('lands a valid containerEnv entry in the Env array sent to POST /containers/create', async () => {
    await createAndStartContainer({
      imageName: 'ghcr.io/infosupport/base-devimage-vscode',
      workspaceDir: '',
      containerName: 'dc-env-valid',
      containerWorkspace: '/workspaces/project',
      presentableName: 'project',
      ideName: 'vscode',
      empty: true,
      containerEnv: { MY_VAR: 'hello' },
    });

    const env: string[] = captured.createBody.Env;
    expect(env).toContain('MY_VAR=hello');
  });

  it('drops a structurally invalid key defensively without throwing', async () => {
    const result = await createAndStartContainer({
      imageName: 'ghcr.io/infosupport/base-devimage-vscode',
      workspaceDir: '',
      containerName: 'dc-env-invalid-key',
      containerWorkspace: '/workspaces/project',
      presentableName: 'project',
      ideName: 'vscode',
      empty: true,
      // api.ts would 400 this before it ever reaches here — this only checks
      // that createAndStartContainer itself never throws or applies it.
      containerEnv: { 'BAD KEY': 'x' } as unknown as Record<string, string>,
    });
    expect(result.ignoredEnv).toEqual(['BAD KEY']);
    const env: string[] = captured.createBody.Env;
    expect(env.some((e) => e.startsWith('BAD KEY='))).toBe(false);
  });
});

describe('buildJbConfigScript / buildVscodeConfigScript — lifecycle command text', () => {
  it('buildJbConfigScript includes the onCreateCommand and postCreateCommand text', () => {
    const script = buildJbConfigScript(
      '/workspaces/project',
      'dc-jb-lifecycle',
      'intellij',
      '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
      '',
      {
        onCreateCommand: 'echo onCreate-marker',
        postCreateCommand: 'touch /tmp/postCreate-marker',
      },
    );
    expect(script).toContain('onCreate-marker');
    expect(script).toContain('postCreate-marker');
    // Both hooks run as the container user, never root.
    expect(script).toMatch(/su vscode -c .*onCreate-marker/);
    expect(script).toMatch(/su vscode -c .*postCreate-marker/);
  });

  it('buildVscodeConfigScript includes the onCreateCommand and postCreateCommand text', () => {
    const script = buildVscodeConfigScript(
      '/workspaces/project',
      'dc-vscode-lifecycle',
      '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
      '',
      {
        onCreateCommand: 'echo onCreate-marker',
        postCreateCommand: 'touch /tmp/postCreate-marker',
      },
    );
    expect(script).toContain('onCreate-marker');
    expect(script).toContain('postCreate-marker');
  });

  it('buildJbConfigScript merges jbSettings into both host-config.json writes', () => {
    const script = buildJbConfigScript(
      '/workspaces/project',
      'dc-jb-settings',
      'intellij',
      'fake-cert',
      '',
      undefined,
      {},
      [],
      { 'some.setting': true },
    );
    // Embedded as a printf %s argument (see buildJbConfigScript's comment) —
    // the JSON text itself appears verbatim, shell-quoted, in the script.
    expect(script).toContain(JSON.stringify({ 'some.setting': true }));
  });

  it('buildJbConfigScript flags the unverified installPlugins invocation when jbPlugins is set', () => {
    const script = buildJbConfigScript(
      '/workspaces/project',
      'dc-jb-plugins',
      'intellij',
      'fake-cert',
      '',
      undefined,
      {},
      ['org.example.plugin'],
      undefined,
    );
    expect(script).toContain('installPlugins');
    expect(script).toContain('org.example.plugin');
    expect(script).toMatch(/UNVERIFIED/);
  });

  it('omits the installPlugins line entirely when jbPlugins is empty', () => {
    const script = buildJbConfigScript(
      '/workspaces/project',
      'dc-jb-no-plugins',
      'intellij',
      'fake-cert',
      '',
    );
    expect(script).not.toContain('installPlugins');
  });
});

describe('createAndStartContainer — initializeCommand (host exec)', () => {
  it('attempts the host exec with the workspace as cwd and a bounded timeout', async () => {
    vi.resetModules();
    const calls: any[] = [];
    // Partial mock: worktree.ts (imported transitively by docker.ts) also
    // pulls `execFile` from child_process at module load time, so replacing
    // the whole module would break that unrelated import — only `exec` (what
    // initializeCommand actually calls) is swapped out.
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return {
        ...actual,
        exec: (cmd: string, opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          calls.push({ cmd, opts });
          cb(null, '', '');
          return {} as any;
        },
      };
    });
    vi.doMock('../src/db', () => ({
      isHostPortApproved: () => false,
      getActionPolicy: () => null,
      getGrant: () => null,
      registerSocketName: () => 'rev-init',
      unregisterSocketNameIfCurrent: () => {},
    }));
    vi.doMock('../src/events', () => ({ notifyStateChanged: () => {} }));
    vi.doMock('../src/socket-registration', () => ({ waitForSocketReadiness: async () => true }));
    vi.doMock('../src/tls-ca', () => ({ getCaCertPem: () => 'fake-cert' }));
    vi.doMock('http', () => ({
      default: {
        request: (opts: { method: string; path: string }, cb: (res: EventEmitter & { statusCode: number }) => void) => {
          const res = Object.assign(new EventEmitter(), { statusCode: 404 });
          const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
          req.write = () => {};
          req.end = () => {
            queueMicrotask(() => {
              cb(res);
              res.emit('data', 'no such container');
              res.emit('end');
            });
          };
          return req;
        },
      },
    }));

    const { createAndStartContainer: createWithMockedExec } = await import('../src/docker');
    await createWithMockedExec({
      imageName: 'ghcr.io/infosupport/base-devimage-vscode',
      workspaceDir: '/home/user/project',
      containerName: 'dc-initialize-command',
      containerWorkspace: '/workspaces/project',
      presentableName: 'project',
      ideName: 'vscode',
      // empty:true short-circuits the (real, unmocked) ensureWorktree/git
      // calls further down — irrelevant to what this test checks, which is
      // only that initializeCommand fired, with what cwd/timeout, before any
      // of that runs.
      empty: true,
      lifecycle: { initializeCommand: 'echo init' },
    }).catch(() => { /* only the initializeCommand call itself is under test */ });

    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe('echo init');
    expect(calls[0].opts.cwd).toBe('/home/user/project');
    expect(calls[0].opts.timeout).toBe(5 * 60 * 1000);

    vi.doUnmock('child_process');
    vi.resetModules();
  });
});
