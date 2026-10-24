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
import { readHeartbeat, heartbeatFresh, writeJsonAtomic } from '../../cli/src/pipe/protocol';

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
