import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
// The host pipe agent lives in the CLI package, which has no test runner of its
// own (zero runtime deps); it is exercised here, like migrate.test.ts does. The
// tests act as the gateway: they drop `<id>.in` files into a temp pipe folder
// served by the real loop, in-process, and read the `<id>.out` replies.
import { servePipe, cleanStale, type ServeHandle } from '../../cli/src/pipe/serve';
import { toHuddlePath, isAbsoluteHostPath } from '../../cli/src/pipe/fs-list';
import { execTool } from '../../cli/src/pipe/tools';
import { sbxLinks, removeNoFollow } from '../../cli/src/pipe/sbx-links';
import { readHeartbeat, heartbeatFresh, writeJsonAtomic, ensurePrivateDir } from '../../cli/src/pipe/protocol';

const isWin = process.platform === 'win32';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };

/** Writes a request the way the gateway does and waits for the reply. */
async function call(dir: string, body: unknown, timeoutMs = 5000): Promise<Reply> {
  const id = crypto.randomBytes(16).toString('hex');
  const inFile = path.join(dir, `${id}.in`);
  if (typeof body === 'string') {
    fs.writeFileSync(`${inFile}.tmp`, body);
    fs.renameSync(`${inFile}.tmp`, inFile);
  } else {
    writeJsonAtomic(inFile, body);
  }
  const out = path.join(dir, `${id}.out`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(out)) {
      const reply = JSON.parse(fs.readFileSync(out, 'utf8')) as Reply;
      fs.unlinkSync(out);
      // The agent deletes the .busy right after writing the reply.
      await new Promise((r) => setTimeout(r, 30));
      expect(fs.existsSync(path.join(dir, `${id}.busy`))).toBe(false);
      return reply;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply for ${id} within ${timeoutMs} ms`);
}

describe('toHuddlePath', () => {
  it('normalizes Windows paths: forward slashes, upper-case drive, root keeps its slash', () => {
    expect(toHuddlePath('c:\\Users\\me\\', 'win32')).toBe('C:/Users/me');
    expect(toHuddlePath('C:', 'win32')).toBe('C:/');
    expect(toHuddlePath('d:/', 'win32')).toBe('D:/');
    expect(toHuddlePath('C:/a/../b', 'win32')).toBe('C:/b');
  });

  it('normalizes POSIX paths', () => {
    expect(toHuddlePath('/home/me/', 'linux')).toBe('/home/me');
    expect(toHuddlePath('/', 'linux')).toBe('/');
    expect(toHuddlePath('//home//me/./x', 'linux')).toBe('/home/me/x');
  });

  it('knows what an absolute host path is per platform', () => {
    expect(isAbsoluteHostPath('/x', 'linux')).toBe(true);
    expect(isAbsoluteHostPath('x/y', 'linux')).toBe(false);
    expect(isAbsoluteHostPath('C:/x', 'win32')).toBe(true);
    expect(isAbsoluteHostPath('C:x', 'win32')).toBe(false);
    expect(isAbsoluteHostPath('/x', 'win32')).toBe(false);
  });
});

describe('host pipe serve loop', () => {
  let dir: string;
  let tree: string;
  let bin: string;
  let handle: ServeHandle;
  const savedBin = process.env.HUDDLE_SBX_BIN;

  beforeAll(() => {
    dir = tmpDir('huddle-pipe-');
    tree = tmpDir('huddle-tree-');
    for (const name of ['beta', 'Alpha', '.hidden', 'gamma', 'delta']) fs.mkdirSync(path.join(tree, name));
    fs.writeFileSync(path.join(tree, 'a-file.txt'), 'not a folder');
    if (!isWin) {
      fs.symlinkSync(path.join(tree, 'beta'), path.join(tree, 'link-to-beta'));
      fs.symlinkSync(path.join(tree, 'missing'), path.join(tree, 'dangling'));
    }

    // A fake `sbx`: echoes its argv one per line, fails or sleeps on request.
    bin = path.join(tmpDir('huddle-bin-'), 'sbx');
    fs.writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'case "$1" in',
        '  version) echo "sbx version 9.9.9" ;;',
        '  argv) shift; for a in "$@"; do printf "%s\\n" "$a"; done ;;',
        '  fail) echo "boom" >&2; exit 3 ;;',
        '  sleep) sleep "$2"; echo slept ;;',
        '  daemon) sleep 5 & echo started ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env.HUDDLE_SBX_BIN = bin;

    // Leftovers from an earlier run: two hours old ones go, a fresh one stays.
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    for (const name of ['old1.busy', 'old2.out', 'old3.out.tmp', 'old4.in']) {
      fs.writeFileSync(path.join(dir, name), '{}');
      fs.utimesSync(path.join(dir, name), old, old);
    }
    fs.writeFileSync(path.join(dir, 'fresh.out'), '{}');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me');
    fs.utimesSync(path.join(dir, 'unrelated.txt'), old, old);

    handle = servePipe({ dir, pollMs: 20, heartbeatMs: 200, maxEntries: 3 });
  });

  afterAll(async () => {
    await handle.stop();
    if (savedBin === undefined) delete process.env.HUDDLE_SBX_BIN;
    else process.env.HUDDLE_SBX_BIN = savedBin;
  });

  it('cleans up stale request/reply files on start and leaves the rest', () => {
    const names = fs.readdirSync(dir);
    for (const name of ['old1.busy', 'old2.out', 'old3.out.tmp', 'old4.in']) expect(names).not.toContain(name);
    expect(names).toContain('fresh.out');
    expect(names).toContain('unrelated.txt');
  });

  it('writes a fresh heartbeat', () => {
    const hb = readHeartbeat(dir);
    expect(hb).not.toBeNull();
    expect(hb!.v).toBe(1);
    expect(hb!.pid).toBe(process.pid);
    expect(hb!.platform).toBe(process.platform);
    expect(heartbeatFresh(hb!)).toBe(true);
    if (!isWin) expect(hb!.tools).toEqual(['sbx']);
  });

  it('host.info reports platform, home and tools', async () => {
    const r = await call(dir, { v: 1, op: 'host.info', args: {} });
    expect(r.ok).toBe(true);
    expect(r.result.platform).toBe(process.platform);
    expect(r.result.home).toBe(toHuddlePath(os.homedir()));
    expect(typeof r.result.version).toBe('string');
    if (!isWin) expect(r.result.tools.sbx).toEqual({ available: true, path: bin, version: 'sbx version 9.9.9' });
  });

  it('fs.list without a path returns the roots', async () => {
    const r = await call(dir, { v: 1, op: 'fs.list', args: {} });
    expect(r.ok).toBe(true);
    expect(r.result.path).toBe('');
    expect(r.result.truncated).toBe(false);
    const paths = r.result.folders.map((f: { path: string }) => f.path);
    if (!isWin) expect(r.result.folders[0]).toEqual({ path: '/', name: '/' });
    expect(paths).toContain(toHuddlePath(os.homedir()));
  });

  it('fs.list lists subfolders sorted case-insensitively, incl. hidden + symlinked, truncated at max', async () => {
    const r = await call(dir, { v: 1, op: 'fs.list', args: { path: `${tree}/` } });
    expect(r.ok).toBe(true);
    const base = toHuddlePath(tree);
    expect(r.result.path).toBe(base);
    expect(r.result.max).toBe(3);
    expect(r.result.truncated).toBe(true);
    // All folders sorted: .hidden, Alpha, beta, delta, gamma, link-to-beta — first 3 kept.
    expect(r.result.folders).toEqual([
      { path: `${base}/.hidden`, name: '.hidden' },
      { path: `${base}/Alpha`, name: 'Alpha' },
      { path: `${base}/beta`, name: 'beta' },
    ]);
  });

  it.skipIf(isWin)('fs.list includes symlinked folders but not dangling links or files', async () => {
    const sub = path.join(tree, 'gamma');
    fs.mkdirSync(path.join(sub, 'z'));
    fs.symlinkSync(path.join(tree, 'beta'), path.join(sub, 'b-link'));
    fs.symlinkSync(path.join(tree, 'nope'), path.join(sub, 'c-dangling'));
    fs.writeFileSync(path.join(sub, 'a.txt'), '');
    const r = await call(dir, { v: 1, op: 'fs.list', args: { path: sub } });
    expect(r.result.folders.map((f: { name: string }) => f.name)).toEqual(['b-link', 'z']);
    expect(r.result.truncated).toBe(false);
  });

  it('fs.list on a missing folder → not_found; a relative path → bad_request', async () => {
    const missing = await call(dir, { v: 1, op: 'fs.list', args: { path: path.join(tree, 'nope') } });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const rel = await call(dir, { v: 1, op: 'fs.list', args: { path: 'relative/dir' } });
    expect(rel).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    const notString = await call(dir, { v: 1, op: 'fs.list', args: { path: 42 } });
    expect(notString).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('sbx.links is an op: a bad sandbox name → bad_request', async () => {
    expect(await call(dir, { v: 1, op: 'sbx.links', args: { name: '../x', links: [] } })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('unknown op → unknown_op', async () => {
    expect(await call(dir, { v: 1, op: 'rm.rf', args: {} })).toMatchObject({ ok: false, error: { code: 'unknown_op' } });
  });

  it('malformed requests → bad_request, and the loop keeps serving', async () => {
    expect(await call(dir, '{not json')).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await call(dir, '[1,2]')).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await call(dir, { v: 2, op: 'host.info' })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await call(dir, { v: 1 })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await call(dir, { v: 1, op: 'tool.run', args: { tool: 'sbx', args: 'version' } })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect((await call(dir, { v: 1, op: 'fs.list', args: {} })).ok).toBe(true);
  });

  it('tool.run refuses tools that are not allowlisted', async () => {
    const r = await call(dir, { v: 1, op: 'tool.run', args: { tool: 'bash', args: ['-c', 'id'] } });
    expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    const proto = await call(dir, { v: 1, op: 'tool.run', args: { tool: 'constructor', args: [] } });
    expect(proto).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
  });

  it.skipIf(isWin)('tool.run passes argv through literally, never via a shell', async () => {
    const args = ['argv', 'two words', '$(whoami)', '`id`', "it's; echo pwned", '&& calc', ''];
    const r = await call(dir, { v: 1, op: 'tool.run', args: { tool: 'sbx', args } });
    expect(r.ok).toBe(true);
    expect(r.result.code).toBe(0);
    expect(r.result.stdout).toBe(args.slice(1).map((a) => `${a}\n`).join(''));
  });

  it.skipIf(isWin)('tool.run passes exit code and stderr through', async () => {
    const r = await call(dir, { v: 1, op: 'tool.run', args: { tool: 'sbx', args: ['fail'] } });
    expect(r).toMatchObject({ ok: true, result: { code: 3, stdout: '', stderr: 'boom\n' } });
  });

  it.skipIf(isWin)('tool.run kills a tool that exceeds its timeout', async () => {
    const r = await call(dir, { v: 1, op: 'tool.run', args: { tool: 'sbx', args: ['sleep', '5'], timeoutMs: 300 } });
    expect(r.ok).toBe(true);
    expect(r.result.code).toBe(124);
    expect(r.result.stderr).toContain('timed out');
  });

  it.skipIf(isWin)('tool.run returns when the tool exits, even if a background child keeps its output open', async () => {
    const started = Date.now();
    const r = await call(dir, { v: 1, op: 'tool.run', args: { tool: 'sbx', args: ['daemon'] } });
    expect(r).toMatchObject({ ok: true, result: { code: 0, stdout: 'started\n' } });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.skipIf(isWin)('a slow tool.run does not block a fast fs.list', async () => {
    const slow = call(dir, { v: 1, op: 'tool.run', args: { tool: 'sbx', args: ['sleep', '1'] } });
    const started = Date.now();
    const fast = await call(dir, { v: 1, op: 'fs.list', args: {} });
    expect(fast.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(800);
    expect((await slow).result).toMatchObject({ code: 0, stdout: 'slept\n' });
  });

  it.skipIf(isWin)('tool.run reports tool_missing when the binary is not there', async () => {
    process.env.HUDDLE_SBX_BIN = path.join(tree, 'no-such-sbx');
    try {
      const r = await call(dir, { v: 1, op: 'tool.run', args: { tool: 'sbx', args: ['version'] } });
      expect(r).toMatchObject({ ok: false, error: { code: 'tool_missing' } });
    } finally {
      process.env.HUDDLE_SBX_BIN = bin;
    }
  });

  it.skipIf(isWin)('tool.run finds the tool on PATH without an override', async () => {
    const savedPath = process.env.PATH;
    delete process.env.HUDDLE_SBX_BIN;
    process.env.PATH = `${path.dirname(bin)}${path.delimiter}${savedPath}`;
    try {
      const r = await call(dir, { v: 1, op: 'tool.run', args: { tool: 'sbx', args: ['version'] } });
      expect(r).toMatchObject({ ok: true, result: { code: 0, stdout: 'sbx version 9.9.9\n' } });
    } finally {
      process.env.PATH = savedPath;
      process.env.HUDDLE_SBX_BIN = bin;
    }
  });
});

describe('host pipe internals', () => {
  it.skipIf(isWin)('execTool caps output per stream', async () => {
    const r = await execTool('/bin/sh', ['-c', 'head -c 5000 /dev/zero | tr "\\0" x'], 5000, 100);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('x'.repeat(100))).toBe(true);
    expect(r.stdout).toContain('output truncated at 100 bytes');
  });

  it.skipIf(isWin)('ensurePrivateDir: owner-only folder, parent closed to others, symlink refused', () => {
    const parent = tmpDir('huddle-priv-');
    fs.chmodSync(parent, 0o777);
    const dir = path.join(parent, 'pipe');
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.chmodSync(dir, 0o777);
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(parent).mode & 0o022).toBe(0);

    const fresh = path.join(parent, 'new');
    ensurePrivateDir(fresh);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);

    const link = path.join(parent, 'link');
    fs.symlinkSync(dir, link);
    expect(() => ensurePrivateDir(link)).toThrow(/symlink/);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('cleanStale skips ids that are still in flight', () => {
    const dir = tmpDir('huddle-stale-');
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    for (const name of ['a.busy', 'b.busy']) {
      fs.writeFileSync(path.join(dir, name), '{}');
      fs.utimesSync(path.join(dir, name), old, old);
    }
    expect(cleanStale(dir, new Set(['a']))).toEqual(['b.busy']);
    expect(fs.readdirSync(dir)).toEqual(['a.busy']);
  });

  it('stop() removes its own heartbeat', async () => {
    const dir = tmpDir('huddle-stop-');
    const h = servePipe({ dir, pollMs: 20 });
    expect(fs.existsSync(path.join(dir, 'host.json'))).toBe(true);
    await h.stop();
    expect(fs.existsSync(path.join(dir, 'host.json'))).toBe(false);
  });
});

describe('sbx.links (folder mappings for a sandbox)', () => {
  let tmp: string;
  let home: string; // stands in for ~/.huddle
  let root: string; // ~/.huddle/sbx/links
  let user: string;
  beforeAll(() => {
    tmp = tmpDir('huddle-sbx-links-');
    home = path.join(tmp, 'user', '.huddle');
    root = path.join(home, 'sbx', 'links');
    user = path.join(tmp, 'user');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    for (const d of ['code', 'tools', 'secret']) {
      fs.mkdirSync(path.join(user, d));
      fs.writeFileSync(path.join(user, d, 'f'), d);
    }
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const run = (args: Record<string, unknown>) => sbxLinks(args, root, home);

  it('links rw and ro mappings into their own folders, private', () => {
    const r = run({ name: 'box', links: [
      { id: 'm1', hostPath: path.join(user, 'code'), readOnly: false },
      { id: 'm2', hostPath: path.join(user, 'tools'), readOnly: true },
    ] });
    expect(r).toEqual({ rw: toHuddlePath(path.join(root, 'box', 'rw')), ro: toHuddlePath(path.join(root, 'box', 'ro')), skipped: [] });
    expect(fs.readFileSync(path.join(root, 'box', 'rw', 'm1', 'f'), 'utf8')).toBe('code');
    expect(fs.readFileSync(path.join(root, 'box', 'ro', 'm2', 'f'), 'utf8')).toBe('tools');
    if (!isWin) expect(fs.statSync(path.join(root, 'box')).mode & 0o777).toBe(0o700);
  });

  it('skips what is missing, not a folder, inside ~/.huddle, or around it while writable', () => {
    fs.writeFileSync(path.join(user, 'file'), '');
    const r = run({ name: 'box', links: [
      { id: 'a', hostPath: path.join(user, 'nope'), readOnly: false },
      { id: 'b', hostPath: path.join(user, 'file'), readOnly: false },
      { id: 'c', hostPath: path.join(home, 'pipe', '..'), readOnly: true },
      { id: 'd', hostPath: user, readOnly: false },
      { id: 'e', hostPath: user, readOnly: true },
    ] });
    expect(r.skipped.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.rw).toBeNull();
    expect(r.ro).toBe(toHuddlePath(path.join(root, 'box', 'ro')));
    // The earlier links of this box are gone: the folder is rebuilt every time.
    expect(fs.existsSync(path.join(root, 'box', 'rw'))).toBe(false);
  });

  it('a mapping that is a symlink into ~/.huddle counts as where it points', () => {
    if (isWin) return;
    const sneaky = path.join(user, 'sneaky');
    fs.symlinkSync(home, sneaky);
    const r = run({ name: 'box', links: [{ id: 'x', hostPath: sneaky, readOnly: true }] });
    expect(r).toEqual({ rw: null, ro: null, skipped: [{ id: 'x', reason: "is Huddle's own folder or inside it" }] });
  });

  it('an empty list removes the folder without following the links in it', () => {
    run({ name: 'box', links: [{ id: 'm1', hostPath: path.join(user, 'code'), readOnly: false }] });
    // Something the sandbox may have left in rw: a link to a folder that is not mapped.
    fs.symlinkSync(path.join(user, 'secret'), path.join(root, 'box', 'rw', 'extra'), isWin ? 'junction' : 'dir');
    expect(run({ name: 'box', links: [] })).toEqual({ rw: null, ro: null, skipped: [] });
    expect(fs.existsSync(path.join(root, 'box'))).toBe(false);
    expect(fs.readFileSync(path.join(user, 'code', 'f'), 'utf8')).toBe('code');
    expect(fs.readFileSync(path.join(user, 'secret', 'f'), 'utf8')).toBe('secret');
  });

  it('refuses bad requests', () => {
    expect(() => run({ name: 'Box', links: [] })).toThrow(/invalid sandbox name/);
    expect(() => run({ name: 'box', links: 'x' })).toThrow(/links must be an array/);
    expect(() => run({ name: 'box', links: [{ id: '../x', hostPath: user }] })).toThrow(/link id/);
    expect(() => run({ name: 'box', links: [{ id: 'a', hostPath: 'rel/path' }] })).toThrow(/absolute/);
    expect(() => run({ name: 'box', links: [{ id: 'a', hostPath: user }, { id: 'a', hostPath: user }] })).toThrow(/duplicate/);
  });

  it('removeNoFollow on a missing path is a no-op', () => {
    expect(() => removeNoFollow(path.join(tmp, 'gone'))).not.toThrow();
  });
});
