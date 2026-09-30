import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { syncManagedSshConfig, writeSshKeyFile, type SbxSshEntry } from '../src/ssh';
import { CONFIG_DIR } from '../src/config';

// syncManagedSshConfig resolves ~/.ssh/config via os.homedir() INSIDE the
// function body (not a module-level constant), so redirecting the right env
// var per test is enough to isolate it — no need to mock fs or os. BUT
// os.homedir() reads HOME only on POSIX: on win32 it reads USERPROFILE (and
// falls back to HOMEDRIVE+HOMEPATH), never HOME at all — overriding only
// HOME therefore isolates nothing on Windows, and every call in that case
// operates on the REAL ~/.ssh/config. This bit a real run once already (see
// git history/PR discussion) before this test learned to override all four,
// mirroring the exact same HOME/USERPROFILE/HOMEDRIVE/HOMEPATH dance
// scripts/dev-full.mjs's childEnv() already uses for the identical reason.
// CONFIG_DIR (used for the rendered UserKnownHostsFile path and
// writeSshKeyFile's target) IS a module-level constant fixed at import time
// to this machine's real home directory — tests read it back rather than
// hardcoding a path, so they don't depend on where this suite happens to run.

const HOME_VARS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const;
const realEnv: Partial<Record<(typeof HOME_VARS)[number], string>> = {};
for (const key of HOME_VARS) {
  if (process.env[key] !== undefined) realEnv[key] = process.env[key];
}
// Captured ONCE, before any beforeEach below ever overrides USERPROFILE —
// os.homedir() called later, inside a test body, would otherwise resolve to
// that test's own tmpHome on win32 instead of this machine's real profile.
const REAL_HOME = os.homedir();
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-ssh-test-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.HOMEDRIVE = tmpHome.slice(0, 2);
  process.env.HOMEPATH = tmpHome.slice(2);
});

afterEach(() => {
  for (const key of HOME_VARS) {
    if (key in realEnv) process.env[key] = realEnv[key];
    else delete process.env[key];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmpHome, '.ssh', 'config');
}

function entry(name: string, port: number, user = 'agent'): SbxSshEntry {
  return { name, port, keyPath: `/tmp/fake-key-${name}`, user };
}

const knownHosts = path.join(CONFIG_DIR, 'ssh', 'known_hosts');

describe('syncManagedSshConfig', () => {
  it('creates ~/.ssh and the config file when neither exists', () => {
    expect(fs.existsSync(path.join(tmpHome, '.ssh'))).toBe(false);
    const r = syncManagedSshConfig([entry('foo', 24851)]);
    expect(r.count).toBe(1);
    expect(fs.existsSync(r.path)).toBe(true);
    const content = fs.readFileSync(r.path, 'utf8');
    expect(content).toContain('Host huddle-sbx-foo');
    expect(content).toContain('  HostName localhost');
    expect(content).toContain('  Port 24851');
    expect(content).toContain('  User agent');
    expect(content).toContain('  IdentityFile /tmp/fake-key-foo');
    expect(content).toContain('  IdentitiesOnly yes');
    expect(content).toContain('  StrictHostKeyChecking no');
    expect(content).toContain(`  UserKnownHostsFile ${knownHosts}`);
  });

  it('creates the config file when ~/.ssh exists but config does not', () => {
    fs.mkdirSync(path.join(tmpHome, '.ssh'), { recursive: true, mode: 0o700 });
    const r = syncManagedSshConfig([entry('bar', 24852)]);
    expect(fs.readFileSync(r.path, 'utf8')).toContain('Host huddle-sbx-bar');
  });

  it('renders one Host block per entry, in order', () => {
    const r = syncManagedSshConfig([entry('foo', 24851), entry('bar', 24852)]);
    const content = fs.readFileSync(r.path, 'utf8');
    expect(r.count).toBe(2);
    expect(content.indexOf('Host huddle-sbx-foo')).toBeLessThan(content.indexOf('Host huddle-sbx-bar'));
  });

  // The login user is discovered per-sandbox at bootstrap (gateway/src/sbx.ts
  // sshBootstrapScript) and is NOT assumed to be uniform — this used to be a
  // hardcoded 'root' for every entry, so a fixture with two different real
  // values is the regression test for that.
  it('renders each entry\'s own User line rather than a single hardcoded value', () => {
    const r = syncManagedSshConfig([entry('foo', 24851, 'agent'), entry('bar', 24852, 'someoneelse')]);
    const content = fs.readFileSync(r.path, 'utf8');
    const fooBlock = content.slice(content.indexOf('Host huddle-sbx-foo'), content.indexOf('Host huddle-sbx-bar'));
    const barBlock = content.slice(content.indexOf('Host huddle-sbx-bar'));
    expect(fooBlock).toContain('  User agent');
    expect(barBlock).toContain('  User someoneelse');
  });

  // Regression test: sandbox names commonly already start with "huddle-sbx-"
  // (the default auto-generated pattern, api.ts's `huddle-sbx-${Date.now()
  // .toString(36)}`, and apparently the create modal's own default too).
  // Prefixing unconditionally produced Host huddle-sbx-huddle-sbx-<x>, an
  // alias `sbx` itself reported as not existing — confirmed against a real
  // sandbox in production use, not a hypothetical.
  it('does not double-prefix a sandbox name that already starts with huddle-sbx-', () => {
    const r = syncManagedSshConfig([entry('huddle-sbx-mumtklto', 24850)]);
    const content = fs.readFileSync(r.path, 'utf8');
    expect(content).toContain('Host huddle-sbx-mumtklto');
    expect(content).not.toContain('huddle-sbx-huddle-sbx-mumtklto');
  });

  it('is idempotent — the same entries synced twice produce byte-identical content', () => {
    const entries = [entry('foo', 24851), entry('bar', 24852)];
    syncManagedSshConfig(entries);
    const first = fs.readFileSync(configPath(), 'utf8');
    syncManagedSshConfig(entries);
    const second = fs.readFileSync(configPath(), 'utf8');
    expect(second).toBe(first);
    // No duplicated sections from a repeated sync.
    expect(first.match(/# BEGIN HUDDLE SBX SSH CONFIG/g)?.length).toBe(1);
  });

  it('removes the managed section entirely once entries goes empty', () => {
    syncManagedSshConfig([entry('foo', 24851)]);
    syncManagedSshConfig([]);
    const content = fs.readFileSync(configPath(), 'utf8');
    expect(content).not.toContain('HUDDLE SBX');
    expect(content).toBe('');
  });

  it('never touches unrelated Host entries, real or synthetic, and restores them exactly once entries goes empty', () => {
    // Exercises the real path against representative content: this machine's
    // own ~/.ssh/config if it has one (read once, from REAL_HOME — captured
    // at module load, before any beforeEach override — then copied into the
    // isolated tmp HOME — never read from or written to again), falling back
    // to a synthetic multi-entry fixture so the suite doesn't depend on the
    // runner's personal machine state to pass (e.g. in CI).
    const realConfigPath = path.join(REAL_HOME, '.ssh', 'config');
    const fixture = fs.existsSync(realConfigPath)
      ? fs.readFileSync(realConfigPath, 'utf8')
      : [
          'Host github.com',
          '  User git',
          '  IdentityFile ~/.ssh/id_ed25519',
          '',
          'Host *.internal',
          '  ProxyJump bastion',
          '  ForwardAgent yes',
          '',
        ].join('\n');

    fs.mkdirSync(path.join(tmpHome, '.ssh'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath(), fixture);

    syncManagedSshConfig([entry('foo', 24851), entry('bar', 24852)]);
    const afterAdd = fs.readFileSync(configPath(), 'utf8');
    expect(afterAdd).toContain('Host huddle-sbx-foo');
    expect(afterAdd).toContain('Host huddle-sbx-bar');
    // Every non-blank line of the original fixture still appears verbatim —
    // nothing outside the markers was rewritten or reformatted.
    for (const line of fixture.split('\n').filter((l) => l.trim())) {
      expect(afterAdd).toContain(line);
    }

    // Idempotent against real-world content too, not just synthetic fixtures.
    syncManagedSshConfig([entry('foo', 24851), entry('bar', 24852)]);
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(afterAdd);

    // Clearing entries restores the file to EXACTLY its original content —
    // the strongest guarantee: nothing was permanently altered.
    syncManagedSshConfig([]);
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(fixture);
  });

  it('only rewrites the file when the computed content actually changes', () => {
    const entries = [entry('foo', 24851)];
    syncManagedSshConfig(entries);
    const before = fs.statSync(configPath()).mtimeMs;
    // Force the mtime backwards so an unwanted rewrite would be detectable
    // even on filesystems with coarse mtime resolution.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(configPath(), past, past);
    syncManagedSshConfig(entries);
    const after = fs.statSync(configPath()).mtimeMs;
    expect(after).toBe(past.getTime());
    expect(after).not.toBe(before);
  });
});

describe('writeSshKeyFile', () => {
  // CONFIG_DIR is fixed at import time to this machine's REAL home directory
  // (unlike syncManagedSshConfig's os.homedir() call, it is not redirected by
  // the HOME override above) — these tests write real files under the real
  // ~/.huddle/ssh/. A fixed slug like "sbx-foo" would risk clobbering (and
  // then deleting) a REAL user's key if they happen to have a sandbox named
  // "foo" — slugs are therefore randomised per run so a collision with a
  // real sandbox name is practically impossible, and each write is preceded
  // by a defensive existsSync check that skips the test entirely (rather
  // than overwrite) on the off chance one is ever already there.
  const runId = crypto.randomUUID();
  const slug = (n: number) => `__huddle_ssh_test_${runId}_${n}__`;
  const usedSlugs: string[] = [];

  function freshSlug(n: number): string {
    const s = slug(n);
    const p = path.join(CONFIG_DIR, 'ssh', s);
    if (fs.existsSync(p)) {
      throw new Error(`refusing to overwrite unexpected pre-existing file at ${p}`);
    }
    usedSlugs.push(s);
    return s;
  }

  afterEach(() => {
    for (const s of usedSlugs.splice(0)) {
      try { fs.unlinkSync(path.join(CONFIG_DIR, 'ssh', s)); } catch { /* not created by this test */ }
    }
  });

  it('writes the key under CONFIG_DIR/ssh/<slug> and returns that path', () => {
    const s = freshSlug(1);
    const p = writeSshKeyFile(s, { privateKey: 'FAKE-KEY-CONTENT' });
    expect(p).toBe(path.join(CONFIG_DIR, 'ssh', s));
    expect(fs.readFileSync(p, 'utf8')).toBe('FAKE-KEY-CONTENT\n');
  });

  it('does not double up a trailing newline that is already there', () => {
    const s = freshSlug(2);
    const p = writeSshKeyFile(s, { privateKey: 'FAKE-KEY-CONTENT\n' });
    expect(fs.readFileSync(p, 'utf8')).toBe('FAKE-KEY-CONTENT\n');
  });

  // Windows does not implement POSIX mode bits the same way (chmod there only
  // toggles a read-only flag), so the 0600 guarantee only means something to
  // assert on platforms that actually have octal permission bits.
  it.skipIf(process.platform === 'win32')('writes the key file with 0600 permissions', () => {
    const p = writeSshKeyFile(freshSlug(3), { privateKey: 'FAKE-KEY-CONTENT' });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });
});
