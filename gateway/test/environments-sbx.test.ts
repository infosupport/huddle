import { describe, it, expect } from 'vitest';
import {
  SbxProvider,
  buildCreateArgs,
  defaultSandboxName,
  parseSbxLsJson,
  parseSbxLsTable,
} from '../src/environments/sbx';
import { InvalidSpecError, ToolFailedError } from '../src/environments/types';
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
    const s = await new SbxProvider(pipe).status();
    expect(s).toEqual({
      id: 'sbx', label: 'Docker Sandbox', available: true, version: 'sbx v0.4.1',
      agents: ['claude', 'codex', 'copilot', 'gemini', 'shell'],
    });
    expect(pipe.calls[0].op).toBe('tool.run');
    expect(pipe.calls[0].args).toMatchObject({ tool: 'sbx', args: ['version'] });
  });

  it('status: tool_missing → available:false; pipe offline gooit door', async () => {
    const missing = await new SbxProvider(fakePipe([new HostPipeError('tool_missing', 'sbx not found on PATH')])).status();
    expect(missing).toMatchObject({ available: false, error: 'sbx is not installed on the host' });
    const failed = await new SbxProvider(fakePipe([{ code: 1, stderr: 'daemon down' }])).status();
    expect(failed).toMatchObject({ available: false, error: 'daemon down' });
    await expect(
      new SbxProvider(fakePipe([new HostPipeError('host_pipe_offline')])).status()
    ).rejects.toMatchObject({ code: 'host_pipe_offline' });
  });

  it('list: ls --json, met tabel-fallback als --json faalt', async () => {
    const json = fakePipe([{ code: 0, stdout: '[{"name":"a","status":"running"}]' }]);
    expect(await new SbxProvider(json).list()).toEqual([{ name: 'a', provider: 'sbx', status: 'running' }]);
    expect(json.calls.map((c) => c.args.args)).toEqual([['ls', '--json']]);

    const old = fakePipe([{ code: 2, stderr: 'unknown flag: --json' }, { code: 0, stdout: 'NAME   STATUS\nb      stopped\n' }]);
    expect(await new SbxProvider(old).list()).toEqual([{ name: 'b', provider: 'sbx', status: 'stopped' }]);
    expect(old.calls.map((c) => c.args.args)).toEqual([['ls', '--json'], ['ls']]);

    const broken = fakePipe([{ code: 1 }, { code: 1, stderr: 'boom' }]);
    await expect(new SbxProvider(broken).list()).rejects.toBeInstanceOf(ToolFailedError);
  });

  it('create: 15 min timeout, standaardnaam, stap met commando en output', async () => {
    const pipe = fakePipe([{ code: 0, stdout: 'created' }]);
    const r = await new SbxProvider(pipe).create({ agent: 'claude', workspaces: [ws('T:/projects/app'), ws('/my docs', true)] });
    expect(r.ok).toBe(true);
    expect(r.name).toMatch(/^huddle-app-[0-9a-f]{4}$/);
    const call = pipe.calls[0];
    expect(call.args).toEqual({
      tool: 'sbx',
      args: ['create', '--name', r.name, 'claude', 'T:/projects/app', '/my docs:ro'],
      timeoutMs: 15 * 60_000,
    });
    expect(call.opts.timeoutMs).toBeGreaterThan(15 * 60_000);
    expect(r.steps).toEqual([
      { label: 'Create sandbox', command: `sbx create --name ${r.name} claude T:/projects/app "/my docs:ro"`, code: 0, stdout: 'created', stderr: '' },
    ]);
  });

  it('create: niet-nul exit → ok:false met stderr in de stap', async () => {
    const r = await new SbxProvider(fakePipe([{ code: 1, stderr: 'already exists' }])).create({
      name: 'box', agent: 'shell', workspaces: [ws('/a')],
    });
    expect(r).toMatchObject({ name: 'box', ok: false, steps: [{ code: 1, stderr: 'already exists' }] });
  });

  it('create: ongeldige invoer bereikt de host niet', async () => {
    const pipe = fakePipe([]);
    await expect(new SbxProvider(pipe).create({ agent: 'claude', workspaces: [ws('relative')] })).rejects.toBeInstanceOf(InvalidSpecError);
    await expect(new SbxProvider(pipe).create({ name: 'Bad', agent: 'claude', workspaces: [ws('/a')] })).rejects.toBeInstanceOf(InvalidSpecError);
    expect(pipe.calls).toEqual([]);
  });

  it('remove: rm [--force] <name>; fout → ToolFailedError', async () => {
    const pipe = fakePipe([{ code: 0 }, { code: 0 }, { code: 1, stderr: 'no such sandbox' }]);
    const p = new SbxProvider(pipe);
    await p.remove('box', { force: false });
    await p.remove('box', { force: true });
    await expect(p.remove('box', { force: false })).rejects.toThrow('no such sandbox');
    expect(pipe.calls.map((c) => c.args.args)).toEqual([['rm', 'box'], ['rm', '--force', 'box'], ['rm', 'box']]);
    await expect(p.remove('--all', { force: false })).rejects.toBeInstanceOf(InvalidSpecError);
  });
});
