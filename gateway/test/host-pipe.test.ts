import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HostPipe, HostPipeError } from '../src/host-pipe';

// De gateway-kant van de host pipe (docs/host-pipe.md) tegen een echte temp-map.
// De "host agent" is hier een minimale lus in de test zelf: .in claimen door te
// hernoemen naar .busy, antwoord als .tmp schrijven en naar .out hernoemen.

let dir: string;
let stopAgent: (() => void) | null = null;

function heartbeat(ageMs = 0, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(dir, 'host.json'),
    JSON.stringify({
      v: 1, pid: 1, version: '9.9.9', platform: 'linux',
      startedAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() - ageMs).toISOString(),
      ...extra,
    })
  );
}

// handler: (req) => reply-object, of 'hang' om te claimen zonder ooit te antwoorden.
function startAgent(handler: (req: any) => any) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.in'))) {
      const id = f.slice(0, -3);
      const busy = path.join(dir, `${id}.busy`);
      try { fs.renameSync(path.join(dir, f), busy); } catch { continue; }
      const req = JSON.parse(fs.readFileSync(busy, 'utf8'));
      const reply = handler(req);
      if (reply === 'hang') continue;
      fs.writeFileSync(path.join(dir, `${id}.out.tmp`), JSON.stringify(reply));
      fs.renameSync(path.join(dir, `${id}.out.tmp`), path.join(dir, `${id}.out`));
      fs.unlinkSync(busy);
    }
    setTimeout(tick, 10);
  };
  tick();
  stopAgent = () => { stopped = true; };
}

const pipe = () => new HostPipe({ dir, claimTimeoutMs: 300, defaultTimeoutMs: 300, pollMs: 10 });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-pipe-'));
});

afterEach(() => {
  stopAgent?.();
  stopAgent = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('HostPipe.call', () => {
  it('stuurt v1-requests en geeft result terug; laat geen bestanden achter', async () => {
    heartbeat();
    let seen: any;
    startAgent((req) => { seen = req; return { ok: true, result: { echo: req.args } }; });
    const result = await pipe().call('host.info', { a: 1 });
    expect(seen).toEqual({ v: 1, op: 'host.info', args: { a: 1 } });
    expect(result).toEqual({ echo: { a: 1 } });
    expect(fs.readdirSync(dir)).toEqual(['host.json']);
  });

  it('vertaalt ok:false naar een HostPipeError met code en message', async () => {
    heartbeat();
    startAgent(() => ({ ok: false, error: { code: 'not_found', message: 'no such folder' } }));
    const err = await pipe().call('fs.list', { path: '/nope' }).catch((e) => e);
    expect(err).toBeInstanceOf(HostPipeError);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('no such folder');
  });

  it('offline als niemand de request claimt, en ruimt de .in op', async () => {
    heartbeat();
    const err = await pipe().call('host.info').catch((e) => e);
    expect(err).toBeInstanceOf(HostPipeError);
    expect(err.code).toBe('host_pipe_offline');
    expect(fs.readdirSync(dir)).toEqual(['host.json']);
  });

  it('offline zonder te wachten als de heartbeat ontbreekt of oud is', async () => {
    const t0 = Date.now();
    const missing = await pipe().call('host.info').catch((e) => e);
    expect(missing.code).toBe('host_pipe_offline');
    heartbeat(60_000);
    const stale = await pipe().call('host.info').catch((e) => e);
    expect(stale.code).toBe('host_pipe_offline');
    expect(Date.now() - t0).toBeLessThan(200);
    expect(fs.readdirSync(dir).filter((f) => f !== 'host.json')).toEqual([]);
  });

  it('timeout als de agent claimt maar niet antwoordt', async () => {
    heartbeat();
    startAgent(() => 'hang');
    const err = await pipe().call('ssh.key', {}, { timeoutMs: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(HostPipeError);
    expect(err.code).toBe('host_pipe_timeout');
  });

  it('offline als de pipe-map niet bestaat (geen agent ooit gestart)', async () => {
    const p = new HostPipe({ dir: path.join(dir, 'missing'), pollMs: 10 });
    // status() faalt al op de ontbrekende heartbeat
    await expect(p.call('host.info')).rejects.toMatchObject({ code: 'host_pipe_offline' });
  });
});

describe('HostPipe.status', () => {
  it('online met verse heartbeat, inclusief versie en platform', () => {
    heartbeat(1_000);
    const s = pipe().status();
    expect(s).toMatchObject({ online: true, version: '9.9.9', platform: 'linux' });
    expect(typeof s.updatedAt).toBe('string');
  });

  it('offline bij een heartbeat ouder dan 10 s', () => {
    heartbeat(11_000);
    expect(new HostPipe({ dir }).status().online).toBe(false);
  });

  it('offline zonder of met onleesbare heartbeat', () => {
    expect(pipe().status()).toEqual({ online: false });
    fs.writeFileSync(path.join(dir, 'host.json'), '{half');
    expect(pipe().status()).toEqual({ online: false });
  });
});
