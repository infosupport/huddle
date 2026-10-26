import { describe, it, expect, vi } from 'vitest';
import {
  SbxProvider,
  SbxStore,
  buildCreateArgs,
  defaultSandboxName,
  parseSbxLsJson,
  parseSbxLsTable,
} from '../src/environments/sbx';
import { InvalidSpecError, ProviderDisabledError, ToolFailedError } from '../src/environments/types';
import { hashProxySecret, parseProxyAuthorization, redactProxyUrls, isHuddleProxyUrl, sbxProxyHostPort } from '../src/environments/sbx-egress';
import { HostPipeError } from '../src/host-pipe';

// De sbx-provider praat alleen via hostPipe.call('tool.run', ...). Hier stubben
// we die call: we leggen vast welke argv naar de host gaat en spelen sbx-output terug.

type Reply = { code: number; stdout?: string; stderr?: string } | Error;

function fakePipe(replies: Reply[]) {
  const calls: { op: string; args: any; opts: any }[] = [];
  return {
    calls,
    call: async (op: string, args: any, opts: any) => {
      calls.push({ op, args, opts });
      const r = replies.shift();
      if (!r) throw new Error('unexpected call');
      if (r instanceof Error) throw r;
      return { stdout: '', stderr: '', ...r } as any;
    },
  };
}

const ws = (path: string, readOnly = false) => ({ path, readOnly });

// In-memory SbxStore: wat de provider in de DB zou zetten, inspecteerbaar.
function memStore(init: { enabled?: boolean; originalProxy?: string | null } = {}) {
  const identities = new Map<string, { hash: string | null; spec: any }>();
  let enabled = init.enabled ?? true;
  let original: string | null = init.originalProxy ?? null;
  const store: SbxStore & { identities: typeof identities } = {
    identities,
    enabled: () => enabled,
    setEnabled: (on) => { enabled = on; },
    resetSecret: () => 'RESETSECRET',
    originalProxy: () => original,
    setOriginalProxy: (v) => { original = v; },
    saveIdentity: (name, hash, spec) => { identities.set(name, { hash, spec }); },
    spec: (name) => identities.get(name)?.spec ?? null,
    identified: (name) => !!identities.get(name)?.hash,
    clearIdentities: () => { for (const v of identities.values()) v.hash = null; },
  };
  return store;
}

const PORT = 32768;
const sbx = (pipe: ReturnType<typeof fakePipe>, store = memStore()) => new SbxProvider(pipe, store, PORT);

describe('buildCreateArgs', () => {
  it('bouwt create --name <n> <agent> <primary> <extra>[:ro]', () => {
    expect(
      buildCreateArgs({
        name: 'box-1',
        agent: 'claude',
        workspaces: [ws('T:\\projects\\app'), ws('/home/me/lib', true), ws('/home/me/docs')],
      })
    ).toEqual(['create', '--name', 'box-1', 'claude', 'T:/projects/app', '/home/me/lib:ro', '/home/me/docs']);
  });

  it('eerste workspace is nooit read-only', () => {
    expect(buildCreateArgs({ name: 'b', agent: 'shell', workspaces: [ws('/a', true)] })).toEqual([
      'create', '--name', 'b', 'shell', '/a',
    ]);
  });

  it('dubbele paden vallen weg (Windows hoofdletterongevoelig)', () => {
    expect(
      buildCreateArgs({ name: 'b', agent: 'codex', workspaces: [ws('C:/X'), ws('c:\\x\\', true), ws('/a'), ws('/a/')] })
    ).toEqual(['create', '--name', 'b', 'codex', 'C:/X', '/a']);
  });

  it.each([
    ['', 'leeg'],
    ['-rf', 'leidend streepje'],
    ['Box', 'hoofdletter'],
    ['a_b', 'underscore'],
    ['a'.repeat(64), 'te lang'],
    ['a b', 'spatie'],
  ])('weigert naam %j (%s)', (name) => {
    expect(() => buildCreateArgs({ name, agent: 'claude', workspaces: [ws('/a')] })).toThrow(InvalidSpecError);
  });

  it('accepteert 63 tekens', () => {
    expect(() => buildCreateArgs({ name: 'a'.repeat(63), agent: 'claude', workspaces: [ws('/a')] })).not.toThrow();
  });

  it('weigert onbekende agent', () => {
    expect(() => buildCreateArgs({ name: 'b', agent: '--help', workspaces: [ws('/a')] })).toThrow(/agent/);
  });

  it.each(['relative/path', '../x', '/a/../b', '/a/$HOME', '/a:ro', 'C:/x:ro', ''])('weigert pad %j', (p) => {
    expect(() => buildCreateArgs({ name: 'b', agent: 'claude', workspaces: [ws('/ok'), ws(p)] })).toThrow(InvalidSpecError);
  });

  it('weigert lege workspaces', () => {
    expect(() => buildCreateArgs({ name: 'b', agent: 'claude', workspaces: [] })).toThrow(/workspace/);
  });

  it('stelt ~/.huddle niet bloot: niet erin, de home alleen read-only en niet als eerste', () => {
    const before = process.env.HUDDLE_HOST_HOME_DIR;
    process.env.HUDDLE_HOST_HOME_DIR = '/home/me/.huddle';
    try {
      const create = (...w: ReturnType<typeof ws>[]) => buildCreateArgs({ name: 'b', agent: 'claude', workspaces: w });
      expect(() => create(ws('/home/me/.huddle/pipe'))).toThrow(InvalidSpecError);
      expect(() => create(ws('/home/me'))).toThrow(/read-only/);
      expect(() => create(ws('/ok'), ws('/home/me'))).toThrow(/read-only/);
      expect(create(ws('/ok'), ws('/home/me', true))).toEqual(['create', '--name', 'b', 'claude', '/ok', '/home/me:ro']);
    } finally {
      if (before === undefined) delete process.env.HUDDLE_HOST_HOME_DIR;
      else process.env.HUDDLE_HOST_HOME_DIR = before;
    }
  });
});

describe('defaultSandboxName', () => {
  it('huddle-<leaf>-<4 hex>, binnen de naamregels', () => {
    expect(defaultSandboxName('T:/Projects/My Project_v2', 'ab12')).toBe('huddle-my-project-v2-ab12');
    expect(defaultSandboxName('C:/', 'ab12')).toBe('huddle-c-ab12');
    expect(defaultSandboxName('/', 'ab12')).toBe('huddle-ab12');
    const long = defaultSandboxName('/x/' + 'a'.repeat(200));
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
});

describe('ls-parsers', () => {
  it('parseSbxLsJson: array, object-wrapper, workspaces, dedupe', () => {
    expect(
      parseSbxLsJson(JSON.stringify([
        { name: 'a', status: 'running', workspaces: ['/x', { path: '/y' }] },
        { Name: 'b', State: 'stopped' },
        'c',
        { name: 'a' },
      ]))
    ).toEqual([
      { name: 'a', provider: 'sbx', status: 'running', workspaces: ['/x', '/y'] },
      { name: 'b', provider: 'sbx', status: 'stopped' },
      { name: 'c', provider: 'sbx' },
    ]);
    expect(parseSbxLsJson(JSON.stringify({ sandboxes: [{ vm_name: 'z' }] }))).toEqual([{ name: 'z', provider: 'sbx' }]);
    expect(parseSbxLsJson('')).toEqual([]);
    expect(parseSbxLsJson('NAME STATUS')).toBeNull();
    expect(parseSbxLsJson('{"foo":1}')).toBeNull();
  });

  it('parseSbxLsTable: kolommen via header, status met spaties', () => {
    const out = [
      'NAME        STATUS        AGENT',
      'box-1       Up 2 hours    claude',
      'box-2       stopped       shell',
      '',
    ].join('\n');
    expect(parseSbxLsTable(out)).toEqual([
      { name: 'box-1', provider: 'sbx', status: 'Up 2 hours' },
      { name: 'box-2', provider: 'sbx', status: 'stopped' },
    ]);
    expect(parseSbxLsTable('solo running')).toEqual([{ name: 'solo', provider: 'sbx', status: 'running' }]);
  });
});

describe('SbxProvider', () => {
  it('status: sbx version → available + eerste regel als versie', async () => {
    const pipe = fakePipe([{ code: 0, stdout: '\nsbx v0.4.1\nbuild abc\n' }]);
    const s = await sbx(pipe).status();
    expect(s).toEqual({
      id: 'sbx', label: 'Docker Sandbox', enabled: true, available: true, version: 'sbx v0.4.1',
      agents: ['claude', 'codex', 'copilot', 'gemini', 'shell'],
    });
    expect(pipe.calls[0].op).toBe('tool.run');
    expect(pipe.calls[0].args).toMatchObject({ tool: 'sbx', args: ['version'] });
  });

  it('status: tool_missing → available:false; pipe offline gooit door', async () => {
    const missing = await sbx(fakePipe([new HostPipeError('tool_missing', 'sbx not found on PATH')])).status();
    expect(missing).toMatchObject({ available: false, error: 'sbx is not installed on the host' });
    const failed = await sbx(fakePipe([{ code: 1, stderr: 'daemon down' }])).status();
    expect(failed).toMatchObject({ available: false, error: 'daemon down' });
    await expect(
      sbx(fakePipe([new HostPipeError('host_pipe_offline')])).status()
    ).rejects.toMatchObject({ code: 'host_pipe_offline' });
  });

  it('list: ls --json, met tabel-fallback als --json faalt', async () => {
    const json = fakePipe([{ code: 0, stdout: '[{"name":"a","status":"running"}]' }]);
    expect(await sbx(json).list()).toEqual([{ name: 'a', provider: 'sbx', status: 'running' }]);
    expect(json.calls.map((c) => c.args.args)).toEqual([['ls', '--json']]);

    const old = fakePipe([{ code: 2, stderr: 'unknown flag: --json' }, { code: 0, stdout: 'NAME   STATUS\nb      stopped\n' }]);
    expect(await sbx(old).list()).toEqual([{ name: 'b', provider: 'sbx', status: 'stopped' }]);
    expect(old.calls.map((c) => c.args.args)).toEqual([['ls', '--json'], ['ls']]);

    const broken = fakePipe([{ code: 1 }, { code: 1, stderr: 'boom' }]);
    await expect(sbx(broken).list()).rejects.toBeInstanceOf(ToolFailedError);
  });

  it('create: 15 min timeout, standaardnaam, stap met commando en output', async () => {
    const pipe = fakePipe([{ code: 0 }, { code: 0, stdout: 'created' }, { code: 0 }]);
    const r = await sbx(pipe).create({ agent: 'claude', workspaces: [ws('T:/projects/app'), ws('/my docs', true)] });
    expect(r.ok).toBe(true);
    expect(r.name).toMatch(/^huddle-app-[0-9a-f]{4}$/);
    const call = pipe.calls[1];
    expect(call.args).toEqual({
      tool: 'sbx',
      args: ['create', '--name', r.name, 'claude', 'T:/projects/app', '/my docs:ro'],
      timeoutMs: 15 * 60_000,
    });
    expect(call.opts.timeoutMs).toBeGreaterThan(15 * 60_000);
    expect(r.steps[1]).toEqual(
      { label: 'Create sandbox', command: `sbx create --name ${r.name} claude T:/projects/app "/my docs:ro"`, code: 0, stdout: 'created', stderr: '' },
    );
  });

  it('create: niet-nul exit → ok:false met stderr in de stap', async () => {
    const r = await sbx(fakePipe([{ code: 0 }, { code: 1, stderr: 'already exists' }, { code: 0 }])).create({
      name: 'box', agent: 'shell', workspaces: [ws('/a')],
    });
    expect(r).toMatchObject({ name: 'box', ok: false, steps: [{ code: 0 }, { code: 1, stderr: 'already exists' }, { code: 0 }] });
  });

  it('create: ongeldige invoer bereikt de host niet', async () => {
    const pipe = fakePipe([]);
    await expect(sbx(pipe).create({ agent: 'claude', workspaces: [ws('relative')] })).rejects.toBeInstanceOf(InvalidSpecError);
    await expect(sbx(pipe).create({ name: 'Bad', agent: 'claude', workspaces: [ws('/a')] })).rejects.toBeInstanceOf(InvalidSpecError);
    expect(pipe.calls).toEqual([]);
  });

  it('remove: rm [--force] <name>; fout → ToolFailedError', async () => {
    const pipe = fakePipe([{ code: 0 }, { code: 0 }, { code: 1, stderr: 'no such sandbox' }]);
    const p = sbx(pipe);
    await p.remove('box', { force: false });
    await p.remove('box', { force: true });
    await expect(p.remove('box', { force: false })).rejects.toThrow('no such sandbox');
    expect(pipe.calls.map((c) => c.args.args)).toEqual([['rm', 'box'], ['rm', '--force', 'box'], ['rm', 'box']]);
    await expect(p.remove('--all', { force: false })).rejects.toBeInstanceOf(InvalidSpecError);
  });
});

describe('sbx egress helpers', () => {
  it('redactProxyUrls maskeert het wachtwoord, niets anders', () => {
    expect(redactProxyUrls('sbx settings set proxy.sandbox http://box:s3cr3t@127.0.0.1:32768 ok'))
      .toBe('sbx settings set proxy.sandbox http://box:***@127.0.0.1:32768 ok');
    expect(redactProxyUrls('see https://docs.docker.com/x')).toBe('see https://docs.docker.com/x');
  });

  it('parseProxyAuthorization leest Basic user:pass (pass mag : bevatten)', () => {
    const h = 'Basic ' + Buffer.from('box:a:b').toString('base64');
    expect(parseProxyAuthorization(h)).toEqual({ user: 'box', pass: 'a:b' });
    expect(parseProxyAuthorization('Bearer x')).toBeNull();
    expect(parseProxyAuthorization(undefined)).toBeNull();
    expect(parseProxyAuthorization('Basic ' + Buffer.from('nocolon').toString('base64'))).toBeNull();
  });

  it('isHuddleProxyUrl / sbxProxyHostPort', () => {
    expect(isHuddleProxyUrl('http://x:y@127.0.0.1:32768', 32768)).toBe(true);
    expect(isHuddleProxyUrl('http://localhost:32768', 32768)).toBe(true);
    expect(isHuddleProxyUrl('http://corp-proxy:8080', 32768)).toBe(false);
    expect(isHuddleProxyUrl('', 32768)).toBe(false);
    expect(sbxProxyHostPort({ HUDDLE_SBX_PROXY_HOST_PORT: '32768' })).toBe(32768);
    expect(sbxProxyHostPort({})).toBeNull();
    expect(sbxProxyHostPort({ HUDDLE_SBX_PROXY_HOST_PORT: '99999' })).toBeNull();
  });
});

describe('SbxProvider egress', () => {
  const secretOf = (args: string[]) => /^http:\/\/([^:]+):([^@]+)@127\.0\.0\.1:32768$/.exec(args[3])!;

  it('create: proxy op eigen secret, create, terug naar reset; alleen de hash wordt bewaard', async () => {
    const store = memStore();
    const pipe = fakePipe([{ code: 0 }, { code: 0 }, { code: 0 }]);
    const r = await sbx(pipe, store).create({ name: 'box', agent: 'shell', workspaces: [ws('T:\\a')] });
    expect(r.ok).toBe(true);
    const argv = pipe.calls.map((c) => c.args.args);
    expect(argv[0].slice(0, 3)).toEqual(['settings', 'set', 'proxy.sandbox']);
    const [, user, secret] = secretOf(argv[0]);
    expect(user).toBe('box');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(argv[1][0]).toBe('create');
    expect(argv[2]).toEqual(['settings', 'set', 'proxy.sandbox', 'http://_huddle-reset:RESETSECRET@127.0.0.1:32768']);
    expect(store.identities.get('box')).toEqual({
      hash: hashProxySecret(secret),
      spec: { name: 'box', agent: 'shell', workspaces: [{ path: 'T:/a', readOnly: false }] },
    });
    // Geen secret in wat de portal te zien krijgt.
    expect(JSON.stringify(r.steps)).not.toContain(secret);
    expect(JSON.stringify(r.steps)).not.toContain('RESETSECRET');
  });

  it('create mislukt → toch terug naar reset, geen identiteit', async () => {
    const store = memStore();
    const pipe = fakePipe([{ code: 0 }, { code: 1, stderr: 'nope' }, { code: 0 }]);
    const r = await sbx(pipe, store).create({ name: 'box', agent: 'shell', workspaces: [ws('/a')] });
    expect(r.ok).toBe(false);
    expect(pipe.calls[2].args.args[3]).toContain('_huddle-reset');
    expect(store.identities.size).toBe(0);
  });

  it('reset terugzetten mislukt → geen identiteit (de volgende box zou dit secret erven)', async () => {
    const store = memStore();
    const r = await sbx(fakePipe([{ code: 0 }, { code: 0 }, { code: 1, stderr: 'locked' }]), store)
      .create({ name: 'box', agent: 'shell', workspaces: [ws('/a')] });
    expect(r.ok).toBe(false);
    expect(store.identities.size).toBe(0);
  });

  it('creates lopen na elkaar: de proxy-instelling wisselt nooit tussendoor', async () => {
    const order: string[] = [];
    const pipe = {
      call: async (_op: string, args: any) => {
        order.push(args.args[0] === 'create' ? `create:${args.args[2]}` : args.args[3].includes('reset') ? 'reset' : `set:${secretUser(args.args[3])}`);
        await new Promise((r) => setTimeout(r, 5));
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const secretUser = (u: string) => /\/\/([^:]+):/.exec(u)![1];
    const p = new SbxProvider(pipe as any, memStore(), PORT);
    await Promise.all([
      p.create({ name: 'a', agent: 'shell', workspaces: [ws('/a')] }),
      p.create({ name: 'b', agent: 'shell', workspaces: [ws('/b')] }),
    ]);
    expect(order).toEqual(['set:a', 'create:a', 'reset', 'set:b', 'create:b', 'reset']);
  });

  it('uit → list/create/remove geven ProviderDisabledError zonder de host te raken', async () => {
    const pipe = fakePipe([]);
    const p = sbx(pipe, memStore({ enabled: false }));
    await expect(p.list()).rejects.toBeInstanceOf(ProviderDisabledError);
    await expect(p.create({ name: 'a', agent: 'shell', workspaces: [ws('/a')] })).rejects.toBeInstanceOf(ProviderDisabledError);
    await expect(p.remove('a', { force: false })).rejects.toBeInstanceOf(ProviderDisabledError);
    expect(pipe.calls).toEqual([]);
  });

  it('aan zonder gepubliceerde poort → foutmelding, status zegt waarom', async () => {
    const p = new SbxProvider(fakePipe([{ code: 0, stdout: 'v1' }]), memStore({ enabled: false }), null);
    await expect(p.setEnabled(true)).rejects.toBeInstanceOf(InvalidSpecError);
    expect((await p.status()).unavailableReason).toMatch(/huddle init/);
  });

  it('aan: eigen proxy bewaren, reset zetten, daemon herstarten, alles herbouwen (ook onbeheerde box)', async () => {
    const store = memStore({ enabled: false });
    const pipe = fakePipe([
      { code: 0, stdout: 'http://corp:8080\n' },           // settings get
      { code: 0 },                                         // settings set reset
      { code: 0 },                                         // daemon restart
      { code: 0, stdout: JSON.stringify([
        { name: 'mine', agent: 'claude', workspaces: ['/w', '/lib:ro'] },
        { name: 'mystery' },
      ]) },                                                // ls --json
      { code: 0 }, { code: 0 }, { code: 0 }, { code: 0 },  // rm, set, create, reset
      { code: 0 },                                         // stop mystery
    ]);
    const p = sbx(pipe, store);
    const steps = await p.setEnabled(true);
    expect(store.enabled()).toBe(true);
    expect(store.originalProxy()).toBe('http://corp:8080');
    expect(steps.map((s) => s.label)).toEqual([
      'Route new sandboxes through Huddle',
      'Restart the sbx daemon so running sandboxes go through Huddle',
    ]);
    await vi.waitFor(() => expect(p['recreate']?.running).toBe(false));
    const argv = pipe.calls.map((c) => c.args.args);
    expect(argv.slice(4, 8).map((a) => a[0] === 'settings' ? 'set' : a.slice(0, 3).join(' '))).toEqual([
      'rm --force mine', 'set', 'create --name mine', 'set',
    ]);
    expect(argv[6]).toEqual(['create', '--name', 'mine', 'claude', '/w', '/lib:ro']);
    expect(argv[8]).toEqual(['stop', 'mystery']);
    expect(store.identities.get('mine')?.hash).toMatch(/^[0-9a-f]{64}$/);
    const rec = p['recreate']!;
    expect(rec.results).toEqual([
      { name: 'mine', ok: true },
      { name: 'mystery', ok: false, message: expect.stringMatching(/cannot be recreated; stopped/) },
    ]);
  });

  it('aan terwijl proxy.sandbox al naar Huddle wijst (crash) → niet als eigen instelling bewaren', async () => {
    const store = memStore({ enabled: false });
    const pipe = fakePipe([{ code: 0, stdout: 'http://x:y@127.0.0.1:32768' }, { code: 0 }, { code: 0 }, { code: 0, stdout: '[]' }]);
    const p = sbx(pipe, store);
    await p.setEnabled(true);
    expect(store.originalProxy()).toBe(''); // de standaard, niet de achtergebleven Huddle-URL
    await vi.waitFor(() => expect(p['recreate']?.running).toBe(false));
  });

  it('uit: identiteiten weg, eigen proxy terug, daemon herstart', async () => {
    const store = memStore({ originalProxy: 'http://corp:8080' });
    store.saveIdentity('a', 'h', { name: 'a', agent: 'shell', workspaces: [ws('/a')] });
    const pipe = fakePipe([{ code: 0 }, { code: 0 }]);
    await sbx(pipe, store).setEnabled(false);
    expect(pipe.calls.map((c) => c.args.args)).toEqual([
      ['settings', 'set', 'proxy.sandbox', 'http://corp:8080'],
      ['daemon', 'restart'],
    ]);
    expect(store.enabled()).toBe(false);
    expect(store.identities.get('a')?.hash).toBeNull();
    expect(store.originalProxy()).toBeNull();

    // Zonder eigen instelling: unset.
    const pipe2 = fakePipe([{ code: 0 }, { code: 0 }]);
    await sbx(pipe2, memStore()).setEnabled(false);
    expect(pipe2.calls[0].args.args).toEqual(['settings', 'unset', 'proxy.sandbox']);
  });

  it('aan: daemon-herstart mislukt → eigen proxy terug, blijft uit, fout naar boven', async () => {
    const store = memStore({ enabled: false });
    const pipe = fakePipe([
      { code: 0, stdout: 'http://corp:8080' }, { code: 0 },  // get, set reset
      { code: 1, stderr: 'daemon kaput' },                   // restart
      { code: 0 },                                           // set corp terug
    ]);
    await expect(sbx(pipe, store).setEnabled(true)).rejects.toBeInstanceOf(ToolFailedError);
    expect(store.enabled()).toBe(false);
    expect(pipe.calls[3].args.args).toEqual(['settings', 'set', 'proxy.sandbox', 'http://corp:8080']);
    expect(pipe.calls).toHaveLength(4); // geen recreate
    expect(store.originalProxy()).toBeNull();
  });

  it('uit: eigen proxy terugzetten mislukt → blijft aan met identiteiten, opnieuw te proberen', async () => {
    const store = memStore({ originalProxy: 'http://corp:8080' });
    store.saveIdentity('a', 'h', { name: 'a', agent: 'shell', workspaces: [ws('/a')] });
    const pipe = fakePipe([{ code: 1, stderr: 'nope' }]);
    await expect(sbx(pipe, store).setEnabled(false)).rejects.toBeInstanceOf(ToolFailedError);
    expect(store.enabled()).toBe(true);
    expect(store.identities.get('a')?.hash).toBe('h');
    expect(store.originalProxy()).toBe('http://corp:8080');
  });

  it('uit: daemon-herstart mislukt → blijft aan', async () => {
    const store = memStore({ originalProxy: 'http://corp:8080' });
    const pipe = fakePipe([{ code: 0 }, { code: 1, stderr: 'nope' }]);
    await expect(sbx(pipe, store).setEnabled(false)).rejects.toBeInstanceOf(ToolFailedError);
    expect(store.enabled()).toBe(true);
  });

  it('uit: gemaskeerde eigen proxy (wachtwoord niet bewaard) → unset en zeg het', async () => {
    const store = memStore({ originalProxy: 'http://me:***@corp:8080' });
    const pipe = fakePipe([{ code: 0 }, { code: 0 }]);
    const steps = await sbx(pipe, store).setEnabled(false);
    expect(pipe.calls[0].args.args).toEqual(['settings', 'unset', 'proxy.sandbox']);
    expect(steps[0].label).toMatch(/set it again/);
  });

  it('uit tijdens een recreate → de rest wordt niet meer herbouwd', async () => {
    const store = memStore();
    store.saveIdentity('a', 'h', { name: 'a', agent: 'shell', workspaces: [ws('/a')] });
    store.saveIdentity('b', 'h', { name: 'b', agent: 'shell', workspaces: [ws('/b')] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const replies: Reply[] = [
      { code: 0, stdout: JSON.stringify([{ name: 'a' }, { name: 'b' }]) }, // ls
      { code: 0 }, { code: 0 }, { code: 0 }, { code: 0 },                  // a: rm, set, create, reset
      { code: 0 }, { code: 0 },                                            // uit: unset, restart
    ];
    const calls: any[] = [];
    const pipe = {
      calls,
      call: async (op: string, args: any, opts: any) => {
        calls.push({ op, args, opts });
        if (args.args[0] === 'rm' && args.args[2] === 'a') await gate;
        const r = replies.shift();
        if (!r) throw new Error('unexpected call');
        return { stdout: '', stderr: '', ...(r as any) };
      },
    };
    const p = new SbxProvider(pipe as any, store, PORT);
    await p.recreateAll('test');
    await vi.waitFor(() => expect(calls.length).toBe(2));
    const off = p.setEnabled(false);
    release();
    await off;
    await vi.waitFor(() => expect(p['recreate']?.running).toBe(false));
    expect(calls.some((c) => c.args.args[0] === 'rm' && c.args.args[2] === 'b')).toBe(false);
    expect(store.enabled()).toBe(false);
    expect(p['recreate']!.results.find((r) => r.name === 'b')).toMatchObject({ ok: false, message: expect.stringMatching(/switched off/) });
  });

  it('reconcile: box zonder bekend secret → alles herbouwen; pipe offline → false', async () => {
    const offline = Object.assign(new Error('offline'), { code: 'host_pipe_offline' });
    expect(await sbx(fakePipe([offline])).reconcile()).toBe(false);

    const known = memStore();
    known.saveIdentity('a', 'h', { name: 'a', agent: 'shell', workspaces: [ws('/a')] });
    const quiet = fakePipe([{ code: 0, stdout: 'http://_huddle-reset:x@127.0.0.1:32768' }, { code: 0, stdout: JSON.stringify([{ name: 'a' }]) }]);
    const p1 = sbx(quiet, known);
    expect(await p1.reconcile()).toBe(true);
    expect(p1['recreate']).toBeUndefined();

    const pipe = fakePipe([
      { code: 0, stdout: 'http://_huddle-reset:x@127.0.0.1:32768' },                     // settings get
      { code: 0, stdout: JSON.stringify([{ name: 'a' }, { name: 'lost' }]) }, // ls (reconcile)
      { code: 0, stdout: JSON.stringify([{ name: 'a' }, { name: 'lost' }]) }, // ls (recreate)
      { code: 0 }, { code: 0 }, { code: 0 }, { code: 0 },                    // a
      { code: 0 },                                                          // stop lost
    ]);
    const p2 = sbx(pipe, known);
    expect(await p2.reconcile()).toBe(true);
    await vi.waitFor(() => expect(p2['recreate']?.running).toBe(false));
    expect(p2['recreate']!.reason).toMatch(/gateway restarted/);
  });

  it('reconcile: gestopt midden in uitzetten (setting is al de eigen) → uitzetten afmaken', async () => {
    const store = memStore({ originalProxy: 'http://me:***@corp:8080' });
    store.saveIdentity('a', 'h', { name: 'a', agent: 'shell', workspaces: [ws('/a')] });
    const pipe = fakePipe([{ code: 0, stdout: 'http://corp:8080' }, { code: 0 }]);
    expect(await sbx(pipe, store).reconcile()).toBe(true);
    expect(pipe.calls.map((c) => c.args.args)).toEqual([['settings', 'get', 'proxy.sandbox'], ['daemon', 'restart']]);
    expect(store.enabled()).toBe(false);
    expect(store.identities.get('a')?.hash).toBeNull();
    expect(store.originalProxy()).toBeNull();

    // Herstart mislukt → blijft aan, later opnieuw.
    const store2 = memStore();
    const pipe2 = fakePipe([{ code: 0, stdout: '' }, { code: 1 }]);
    expect(await sbx(pipe2, store2).reconcile()).toBe(false);
    expect(store2.enabled()).toBe(true);
  });

  it('reconcile: gestopt midden in aanzetten (uit, maar setting wijst naar Huddle) → terugdraaien', async () => {
    const store = memStore({ enabled: false, originalProxy: 'http://corp:8080' });
    const pipe = fakePipe([{ code: 0, stdout: 'http://_huddle-reset:x@127.0.0.1:32768' }, { code: 0 }, { code: 0 }]);
    expect(await sbx(pipe, store).reconcile()).toBe(true);
    expect(pipe.calls.map((c) => c.args.args)).toEqual([
      ['settings', 'get', 'proxy.sandbox'],
      ['settings', 'set', 'proxy.sandbox', 'http://corp:8080'],
      ['daemon', 'restart'],
    ]);
    expect(store.enabled()).toBe(false);
    expect(store.originalProxy()).toBeNull();

    // Gewoon uit (niets bewaard): geen enkele call naar de host.
    const idle = fakePipe([]);
    expect(await sbx(idle, memStore({ enabled: false })).reconcile()).toBe(true);
    expect(idle.calls).toHaveLength(0);

    // Herstart mislukt → later opnieuw, het merkteken blijft.
    const store2 = memStore({ enabled: false, originalProxy: '' });
    const pipe2 = fakePipe([{ code: 0, stdout: 'http://corp:8080' }, { code: 1 }]);
    expect(await sbx(pipe2, store2).reconcile()).toBe(false);
    expect(store2.originalProxy()).toBe('');
  });

  it('verwijderen tijdens een recreate → die box komt niet terug', async () => {
    const store = memStore();
    store.saveIdentity('a', 'h', { name: 'a', agent: 'shell', workspaces: [ws('/a')] });
    store.saveIdentity('b', 'h', { name: 'b', agent: 'shell', workspaces: [ws('/b')] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const replies: Reply[] = [
      { code: 0, stdout: JSON.stringify([{ name: 'a' }, { name: 'b' }]) }, // ls
      { code: 0 }, { code: 0 }, { code: 0 }, { code: 0 },                  // a: rm, set, create, reset
      { code: 0 },                                                         // rm b (portal)
    ];
    const calls: any[] = [];
    const pipe = {
      calls,
      call: async (op: string, args: any, opts: any) => {
        calls.push({ op, args, opts });
        if (args.args[0] === 'rm' && args.args[2] === 'a') await gate;
        const r = replies.shift();
        if (!r) throw new Error('unexpected call');
        return { stdout: '', stderr: '', ...(r as any) };
      },
    };
    const p = new SbxProvider(pipe as any, store, PORT);
    await p.recreateAll('test');
    await vi.waitFor(() => expect(calls.length).toBe(2));
    const rm = p.remove('b', { force: false });
    await Promise.resolve();
    expect(calls).toHaveLength(2); // wacht in de rij tot a klaar is
    release();
    await rm;
    await vi.waitFor(() => expect(p['recreate']?.running).toBe(false));
    expect(calls.map((c) => c.args.args.slice(0, 2).join(' ')).filter((c) => c.startsWith('rm'))).toEqual(['rm --force', 'rm b']);
    expect(calls.some((c) => c.args.args[0] === 'create' && c.args.args[2] === 'b')).toBe(false);
    expect(store.identified('b')).toBe(false);
    expect(p['recreate']!.results.find((r) => r.name === 'b')).toMatchObject({ ok: false, message: expect.stringMatching(/removed/) });
  });

  it('reset-secret gezien: één recreate tegelijk, daarna afkoelen', async () => {
    const pipe = fakePipe([{ code: 0, stdout: '[]' }]);
    const p = sbx(pipe);
    p.onResetSecretSeen();
    p.onResetSecretSeen();
    await vi.waitFor(() => expect(p['recreate']?.running).toBe(false));
    p.onResetSecretSeen(); // binnen de cooldown: geen nieuwe ls
    await new Promise((r) => setTimeout(r, 10));
    expect(pipe.calls).toHaveLength(1);
    expect(p['recreate']?.reason).toMatch(/reset secret/);
  });
});
