import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
// The host pipe agent lives in the CLI package; it is exercised here, like
// migrate.test.ts does. The tests act as the gateway: they drop `<id>.in` files
// into a temp pipe folder served by the real loop, in-process, and read the
// `<id>.out` replies.
import { servePipe, cleanStale, type ServeHandle } from '../../cli/src/pipe/serve';
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

describe('host pipe serve loop', () => {
  let dir: string;
  let handle: ServeHandle;

  beforeAll(() => {
    dir = tmpDir('huddle-pipe-');
    // Leftovers from an earlier run: two hours old ones go, a fresh one stays.
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    for (const name of ['old1.busy', 'old2.out', 'old3.out.tmp', 'old4.in']) {
      fs.writeFileSync(path.join(dir, name), '{}');
      fs.utimesSync(path.join(dir, name), old, old);
    }
    fs.writeFileSync(path.join(dir, 'fresh.out'), '{}');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me');
    fs.utimesSync(path.join(dir, 'unrelated.txt'), old, old);

    handle = servePipe({ dir, pollMs: 20, heartbeatMs: 200 });
  });

  afterAll(async () => {
    await handle.stop();
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
  });

  it('host.info reports the platform', async () => {
    const r = await call(dir, { v: 1, op: 'host.info', args: {} });
    expect(r.ok).toBe(true);
    expect(r.result.platform).toBe(process.platform);
  });

  it('ssh.host refuses an alias that is not <name>.huddle', async () => {
    expect(await call(dir, { v: 1, op: 'ssh.host', args: { alias: '../x', remove: true } }))
      .toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('unknown op → unknown_op, also for ops this agent does not have', async () => {
    expect(await call(dir, { v: 1, op: 'rm.rf', args: {} })).toMatchObject({ ok: false, error: { code: 'unknown_op' } });
    expect(await call(dir, { v: 1, op: 'tool.run', args: { tool: 'sh', args: [] } }))
      .toMatchObject({ ok: false, error: { code: 'unknown_op' } });
  });

  it('malformed requests → bad_request, and the loop keeps serving', async () => {
    expect(await call(dir, '{not json')).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await call(dir, '[1,2]')).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await call(dir, { v: 2, op: 'host.info' })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await call(dir, { v: 1 })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect((await call(dir, { v: 1, op: 'host.info', args: {} })).ok).toBe(true);
  });
});

describe('host pipe internals', () => {
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
