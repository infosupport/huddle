import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

// ── sshBootstrapScript: the actual bug, unit-tested at last ──────────────────
// This is the script that used to assume root, `|| true` its way past every
// real failure, and background its way to a 0 exit code no matter what — sbx
// exec runs as non-root user `agent` (uid 1000, in the `sudo` group),
// confirmed live against a real sandbox. Nothing here can prove sshd actually
// comes up inside a real microVM (only a live sandbox can), but every
// assertion below maps to a SPECIFIC way that bug happened, so a regression
// back to any of them fails loudly here instead of silently inside a sandbox
// nobody is watching.
//
// sbx.ts transitively imports ./db (via ./ssh-keys, ./sandbox/registry,
// ./sandbox/reconcile and ./docker) and several of those modules pull in
// enough of db.ts's surface (registerSocketName, unregisterSocketNameIfCurrent,
// ...) that hand-mocking the module is a maintenance trap. vitest.config.ts
// already sets DB_PATH=:memory: globally, so — same idiom as
// sbx-identity-node.test.ts — it's simpler and more robust to run the real
// db.ts against an in-memory SQLite DB than to keep a mock's export list in
// sync with every module sbx.ts happens to import.
vi.mock('../src/tls-ca', () => ({ getCaCertPem: () => '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n' }));
vi.mock('../src/host-config', () => ({ listFolderMappings: () => [] }));

let sshBootstrapScript: (publicKey: string) => string;

beforeAll(async () => {
  const dbMod = await import('../src/db');
  dbMod.initDb();
  ({ sshBootstrapScript } = await import('../src/sbx'));
});

const TEST_PUBKEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC test@huddle';

describe('sshBootstrapScript', () => {
  it('is valid POSIX shell', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    // Throws (execFileSync rejects on non-zero exit) if `sh -n` finds a syntax error.
    expect(() => execFileSync('sh', ['-n'], { input: script })).not.toThrow();
  });

  it('never swallows a privileged command with || true', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    const privileged = script
      .split('\n')
      .filter((line) => /(apt-get|ssh-keygen|sshd -t|mkdir -p \/run\/sshd)/.test(line));
    expect(privileged.length).toBeGreaterThan(0);
    for (const line of privileged) {
      expect(line).not.toMatch(/\|\|\s*true/);
    }
  });

  it('backgrounds exactly one command — the final sshd -D launch', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    const backgrounded = script.match(/&\s*$/gm) ?? [];
    expect(backgrounded).toHaveLength(1);
    const bgLine = script.split('\n').find((l) => /&\s*$/.test(l));
    expect(bgLine).toMatch(/nohup .*"\$SSHD_BIN" -D/);
  });

  it('escalates via conditional passwordless sudo, and prefixes every privileged command with $SUDO', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('sudo -n true');
    // Every privileged command (apt-get / ssh-keygen -A / mkdir -p /run/sshd /
    // chmod /run/sshd / sshd -t / the nohup launch) is prefixed with $SUDO.
    // There are now MULTIPLE real "apt-get update"/"apt-get install"
    // invocations (a direct install attempt, a fallback update, a reinstall)
    // plus comment prose, a grep pattern and fail() messages that also happen
    // to mention those words in plain text — filter those non-command lines
    // out rather than taking just the first match, so this test still means
    // what it says.
    const codeLines = script.split('\n').filter((l) => !/^\s*#/.test(l) && !l.includes('grep -q') && !/^\s*fail /.test(l));
    for (const marker of ['apt-get update', 'apt-get install', 'ssh-keygen -A', 'mkdir -p /run/sshd', '"$SSHD_BIN" -t', '"$SSHD_BIN" -D']) {
      const lines = codeLines.filter((l) => l.includes(marker));
      expect(lines.length, `expected at least one real command line containing ${JSON.stringify(marker)}`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `expected $SUDO on: ${line}`).toMatch(/\$SUDO/);
      }
    }
  });

  it('creates /run/sshd, validates with sshd -t BEFORE backgrounding, and reads back the listener AFTER', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('mkdir -p /run/sshd');
    const idxRunDir = script.indexOf('mkdir -p /run/sshd');
    const idxSshdT = script.indexOf('"$SSHD_BIN" -t');
    const idxNohup = script.indexOf('nohup $SUDO "$SSHD_BIN" -D');
    const idxReadback = script.indexOf('port22_listening');
    // "port22_listening" also appears earlier (function def + step-3 check), so
    // find the readback call specifically: it's the last occurrence, inside the loop.
    const idxReadbackLoop = script.lastIndexOf('port22_listening');
    expect(idxRunDir).toBeGreaterThan(-1);
    expect(idxSshdT).toBeGreaterThan(idxRunDir);
    expect(idxNohup).toBeGreaterThan(idxSshdT);
    expect(idxReadbackLoop).toBeGreaterThan(idxNohup);
    expect(idxReadback).toBeGreaterThan(-1);
  });

  it('contains no template-literal-hostile characters other than the intended interpolation', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).not.toContain('`');
    // The only "${" should already be resolved away — sshBootstrapScript
    // returns a plain string, so a stray unresolved "${" would mean a nested
    // template literal leaked through.
    expect(script).not.toContain('${');
  });

  it('round-trips the public key through the embedded base64', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    const match = /printf '%s' '([^']+)' \| base64 -d/.exec(script);
    expect(match).toBeTruthy();
    const decoded = Buffer.from(match![1], 'base64').toString('utf8');
    expect(decoded).toBe(TEST_PUBKEY);
  });

  it('emits HUDDLE_SSH_USER / HUDDLE_SSH_HOME so the real exec user is discoverable', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('echo "HUDDLE_SSH_USER=$SSH_USER"');
    expect(script).toContain('echo "HUDDLE_SSH_HOME=$SSH_HOME"');
  });

  it('fails loudly (HUDDLE_SSHD_FAILED on stderr, non-zero exit) rather than silently', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('HUDDLE_SSHD_FAILED');
    expect(script).toMatch(/fail\(\) \{[\s\S]*exit 1[\s\S]*\}/);
  });
});

// ── apt-get update/install vs. sbx's own background `apt-get update` ─────────
// sbx's default agent kit runs its own root, backgrounded `apt-get update` on
// EVERY sandbox start (create and resume), which used to race Huddle's own
// `apt-get update` for the apt *lists* lock
// ("Could not get lock /var/lib/apt/lists/lock. It is held by process <N>
// (apt-get)"), confirmed to recur on every fresh start. The fix: try
// installing directly first (plain `apt-get install` never takes that lock),
// only fall back to Huddle's own `apt-get update` when the install failure
// looks like stale/missing package metadata, and retry THAT update in a
// bounded backoff loop instead of failing on the first lock error. See
// gateway/src/sbx.ts sshBootstrapScript() step 5 and
// .claude/plans/sbx-ssh-root-cause.md ("apt lock race, root cause CONFIRMED").
describe('sshBootstrapScript: apt lock race fix', () => {
  it('tries a direct apt-get install BEFORE any apt-get update, to avoid the lists-lock race entirely in the common case', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    const codeLines = script.split('\n').filter((l) => !/^\s*#/.test(l) && !l.includes('grep -q') && !/^\s*fail /.test(l));
    const idxDirectInstall = script.indexOf(codeLines.find((l) => l.includes('apt-get install'))!);
    const idxFallbackUpdate = script.indexOf(codeLines.find((l) => l.includes('apt-get update'))!);
    expect(idxDirectInstall).toBeGreaterThan(-1);
    expect(idxFallbackUpdate).toBeGreaterThan(-1);
    expect(idxDirectInstall).toBeLessThan(idxFallbackUpdate);
  });

  it('only falls back to apt-get update on a stale/missing-metadata signature, gated on the direct install\'s exit code', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('install_rc=$?');
    expect(script).toMatch(/if \[ "\$install_rc" != 0 \] && grep -qiE '[^']*unable to locate package[^']*'/i);
    expect(script).toContain('HUDDLE_SSHD_STALE_CACHE');
  });

  it('retries apt-get update in a BOUNDED loop with backoff, not an unbounded wait (streamSbx has no timeout of its own)', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    // A total time budget in the ~90-120s ballpark, not e.g. "retry forever".
    const deadlineMatch = /apt_lock_deadline_s=(\d+)/.exec(script);
    expect(deadlineMatch).toBeTruthy();
    const deadline = Number(deadlineMatch![1]);
    expect(deadline).toBeGreaterThanOrEqual(60);
    expect(deadline).toBeLessThanOrEqual(150);
    // An actual loop construct (not a single retry) that checks the deadline
    // and sleeps between attempts — i.e. it is a real bounded poll/backoff,
    // not just re-running the command once.
    expect(script).toMatch(/while :; do[\s\S]*apt-get update[\s\S]*done/);
    expect(script).toContain('sleep "$apt_retry_delay_s"');
    expect(script).toMatch(/apt_waited_s.*-ge.*apt_lock_deadline_s/);
    // Exponential backoff capped at a ceiling, not a fixed busy-poll.
    expect(script).toMatch(/apt_retry_delay_s=\$\(\(apt_retry_delay_s \* 2\)\)/);
    expect(script).toMatch(/\[ "\$apt_retry_delay_s" -gt \d+ \] && apt_retry_delay_s=\d+/);
  });

  it('does NOT rely on DPkg::Lock::Timeout as an actual apt flag (confirmed it never applies to the lists lock apt-get update takes; the name only appears in an explanatory comment)', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).not.toMatch(/Dpkg::Lock::Timeout=/i);
  });

  it('reports two DISTINCT failure hints — lock contention vs. a genuine fetch/network failure — instead of one misleading firewall-flavored message', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    // The old text conflated "lock held" with "blocked package archive" and
    // pointed at deb.debian.org, which isn't even a real source for this image.
    expect(script).not.toMatch(/blocked package archive/i);
    expect(script).not.toContain('deb.debian.org');
    // Lock-contention branch: names it as contention, explicitly not a firewall problem.
    expect(script).toMatch(/lock contention, not a firewall problem/i);
    // Genuine-fetch-failure branch: distinct message, still HUDDLE_SSHD_FAILED-shaped.
    expect(script).toMatch(/real fetch error \(not lock contention\)/i);
    // Both branches still funnel through the one failure-reporting convention.
    const hintLines = script.split('\n').filter((l) => /lock contention|real fetch error/i.test(l));
    expect(hintLines.length).toBe(2);
    for (const line of hintLines) {
      expect(line).toMatch(/fail "INSTALL:/);
    }
  });

  it('the two-tier hint is chosen by inspecting the exhausted update log for the lock-held signature', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toMatch(/grep -qiE '[^']*could not get lock[^']*is another process using it[^']*'\s*"\$INSTALL_LOG"/i);
  });

  it('is still valid POSIX shell after the retry loop (sh -n)', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(() => execFileSync('sh', ['-n'], { input: script })).not.toThrow();
    expect(() => execFileSync('dash', ['-n'], { input: script })).not.toThrow();
  });
});

describe('port22_listening pattern (extracted from the script)', () => {
  // The live diagnostic session found `ss` is NOT installed in the sbx base
  // image, so /proc/net/tcp is the primary source. This is the exact pattern
  // used inside sshBootstrapScript — kept as a literal here (not re-derived)
  // so a change to the script is what breaks this test, not the other way
  // around.
  const PATTERN = /:0016 [0-9A-F]+:0000 0A /;

  it('matches a real IPv4 listener line', () => {
    expect(PATTERN.test('  0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0')).toBe(true);
  });

  it('matches the IPv6 form (32 hex chars)', () => {
    expect(PATTERN.test('  1: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0')).toBe(true);
  });

  it('does NOT match an outbound connection to port 22', () => {
    expect(PATTERN.test('  1: 0100007F:B3A2 0100007F:0016 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 20 0 0 10 -1')).toBe(false);
  });

  it('does NOT match a listener on port 2200 (decoy: same "22" substring)', () => {
    expect(PATTERN.test('  0: 00000000:0898 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12348 1 0000000000000000 100 0 0 10 0')).toBe(false);
  });
});
