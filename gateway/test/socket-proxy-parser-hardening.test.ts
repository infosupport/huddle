import { describe, it, expect, vi } from 'vitest';

// ── Docker socket proxy: parser-differential hardening ───────────────────────
// The Docker daemon (Go encoding/json) matches struct fields CASE-INSENSITIVELY
// and merges duplicate keys. The old proxy read keys case-sensitively,
// so the host-escape PoC (poc-suite.sh: 1a/1b/1c/fs, exec #7, mask) bypassed every
// HostConfig/exec check with a different casing or an empty override.
//
// This suite covers the pure validation core: every PoC vector must be denied
// regardless of the casing, and legitimate (canonical) traffic must keep passing.
//
// socket-proxy imports db.ts only for grant checks; mocking keeps db.ts — which
// opens a database at import — out of this test (see socket-proxy.test.ts).
vi.mock('../src/db', () => ({
  getGrant: () => null,
  getActionPolicy: () => null,
  isHostPortApproved: () => false,
}));

import {
  validateHostConfig,
  validateExecConfig,
  validateVolumeCreate,
  findAmbiguousKey,
  deepLowerKeys,
  renameKeyCI,
} from '../src/socket-proxy';

// Broad mount permissions so that mount toggles do not interfere with the tests that
// specifically cover the privilege/host vectors. Bind stays closed (host-path escape).
const OPEN: { bind: boolean; named: boolean; anonymous: boolean } = { bind: false, named: true, anonymous: true };

describe('validateHostConfig — privilege hard-denies are casing-agnostic', () => {
  // Finding #1b/#1c: lowercase inner keys under a correctly capitalized
  // (or lowercase) HostConfig.
  it('denies Privileged in every casing', () => {
    expect(validateHostConfig({ Privileged: true })).toMatch(/Privileged/);
    expect(validateHostConfig({ privileged: true })).toMatch(/Privileged/);
    expect(validateHostConfig({ PRIVILEGED: true })).toMatch(/Privileged/);
  });

  it('denies PidMode=host in every casing (PoC pop-calc requires host PID ns)', () => {
    expect(validateHostConfig({ PidMode: 'host' })).toMatch(/PidMode/);
    expect(validateHostConfig({ pidmode: 'host' })).toMatch(/PidMode/);
  });

  it('denies a host-path bind regardless of the Binds casing (PoC 1c: /:/host)', () => {
    expect(validateHostConfig({ Binds: ['/:/host'] })).toMatch(/bind/i);
    expect(validateHostConfig({ binds: ['/:/host'] })).toMatch(/bind/i);
  });

  it('denies VolumesFrom / DeviceCgroupRules / DeviceRequests lowercase', () => {
    expect(validateHostConfig({ volumesfrom: ['other'] })).toMatch(/VolumesFrom/);
    expect(validateHostConfig({ devicecgrouprules: ['a *:* rwm'] })).toMatch(/DeviceCgroupRules/);
    expect(validateHostConfig({ devicerequests: [{ Count: -1 }] })).toMatch(/DeviceRequests/);
  });

  it('denies a bind-type Mount with lowercase `type` (parser-differential in Mounts)', () => {
    expect(validateHostConfig({ Mounts: [{ Type: 'bind', Source: '/etc', Target: '/x' }] })).toMatch(/bind/i);
    expect(validateHostConfig({ mounts: [{ type: 'bind', source: '/etc', target: '/x' }] })).toMatch(/bind/i);
  });

  it('denies a volume mount with inline DriverConfig regardless of casing', () => {
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', Source: 'v', VolumeOptions: { DriverConfig: { Name: 'local' } } }] }, OPEN))
      .toMatch(/DriverConfig/);
    expect(validateHostConfig({ mounts: [{ type: 'volume', source: 'v', volumeoptions: { driverconfig: { name: 'local' } } }] }, OPEN))
      .toMatch(/DriverConfig/);
  });
});

describe('validateHostConfig — mask/RO unmask (PoC `mask`)', () => {
  it('denies an empty MaskedPaths (unmasks /proc/kcore + sysrq-trigger)', () => {
    expect(validateHostConfig({ MaskedPaths: [] })).toMatch(/MaskedPaths/);
    expect(validateHostConfig({ maskedpaths: [] })).toMatch(/MaskedPaths/);
  });
  it('denies an empty ReadonlyPaths', () => {
    expect(validateHostConfig({ ReadonlyPaths: [] })).toMatch(/ReadonlyPaths/);
    expect(validateHostConfig({ readonlypaths: [] })).toMatch(/ReadonlyPaths/);
  });
  it('also denies a non-empty (trimmed-down) override', () => {
    expect(validateHostConfig({ MaskedPaths: ['/proc/keep'] })).toMatch(/MaskedPaths/);
  });
  // Regression: on EVERY `docker create` the docker CLI sends
  // `MaskedPaths: null` / `ReadonlyPaths: null` by default (null = "daemon fills in secure
  // defaults", actually safe). If we denied on "present" instead of "is an array",
  // every ordinary create would fail here before the real security checks —
  // exactly the e2e regression on finding #8 (named-volume ownership).
  it('lets a null MaskedPaths/ReadonlyPaths through (CLI default → daemon defaults)', () => {
    expect(validateHostConfig({ MaskedPaths: null, ReadonlyPaths: null })).toBeNull();
    expect(validateHostConfig({ maskedpaths: null, readonlypaths: null })).toBeNull();
  });
});

describe('validateHostConfig — case-insensitive duplicate keys (Go merges dupes)', () => {
  it('denies when a dangerous value rides along under a second casing', () => {
    // Benign first, evil after
    expect(validateHostConfig({ Privileged: false, privileged: true })).toMatch(/ambiguous|Privileged/);
    // Evil first, benign after — must NOT be silently let through
    expect(validateHostConfig({ privileged: true, Privileged: false })).toMatch(/ambiguous|Privileged/);
  });
  it('denies duplicate keys nested in Mounts', () => {
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', type: 'bind' }] }, OPEN)).toMatch(/ambiguous/);
  });
});

describe('validateHostConfig — legitimate traffic keeps passing', () => {
  it('accepts an ordinary, safe HostConfig (no false positives)', () => {
    expect(validateHostConfig({
      NetworkMode: 'bridge',
      Memory: 0,
      RestartPolicy: { Name: '', MaximumRetryCount: 0 },
      AutoRemove: true,
      Binds: [],
      LogConfig: { Type: '', Config: {} },
    }, OPEN)).toBeNull();
  });
  it('accepts explicit false/empty for the hard-checked fields', () => {
    expect(validateHostConfig({ Privileged: false, PidMode: '', IpcMode: 'private', CapAdd: [] })).toBeNull();
  });
  it('accepts a named-volume bind when named is allowed', () => {
    expect(validateHostConfig({ Binds: ['myvol:/data'] }, OPEN)).toBeNull();
  });
});

describe('validateHostConfig — port-approval marker is casing-agnostic', () => {
  it('returns the __PORT_CHECK__ marker for HostPort in every casing', () => {
    expect(validateHostConfig({ PortBindings: { '3000/tcp': [{ HostPort: '3000' }] } }))
      .toBe('__PORT_CHECK__:3000:tcp');
    // lowercase `hostport` used to evade the check (hostPort=0 → no marker)
    expect(validateHostConfig({ portbindings: { '3000/tcp': [{ hostport: '3000' }] } }))
      .toBe('__PORT_CHECK__:3000:tcp');
  });
});

describe('validateExecConfig — privileged exec (finding #7)', () => {
  it('denies Privileged:true in every casing', () => {
    expect(validateExecConfig({ Privileged: true, Cmd: ['/bin/sh'] })).toMatch(/Privileged/);
    expect(validateExecConfig({ privileged: true, Cmd: ['/bin/sh'] })).toMatch(/Privileged/);
  });
  it('denies a duplicate Privileged key', () => {
    expect(validateExecConfig({ Privileged: true, privileged: false })).toMatch(/ambiguous|Privileged/);
  });
  it('lets an ordinary (non-privileged) exec through', () => {
    expect(validateExecConfig({ Cmd: ['/bin/sh', '-c', 'echo hi'], AttachStdout: true })).toBeNull();
    expect(validateExecConfig({ Privileged: false, Cmd: ['ls'] })).toBeNull();
  });
});

describe('validateVolumeCreate — bind-backed volume, casing-agnostic', () => {
  it('denies a local bind-backed volume regardless of the DriverOpts casing', () => {
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: { type: 'none', o: 'bind', device: '/' } }))
      .toMatch(/bind-backed/);
    // lowercase `driveropts` used to evade the check → now also denied
    expect(validateVolumeCreate({ driver: 'local', driveropts: { type: 'none', o: 'bind', device: '/' } }))
      .toMatch(/bind-backed/);
  });
  it('denies a duplicate DriverOpts key', () => {
    expect(validateVolumeCreate({ DriverOpts: { device: '/' }, driveropts: {} })).toMatch(/ambiguous/);
  });
  it('lets an ordinary named volume through', () => {
    expect(validateVolumeCreate({ Name: 'data' })).toBeNull();
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: {} })).toBeNull();
  });
});

describe('depth limit against stack-overflow DoS (CWE-674)', () => {
  // Regression: V8's JSON.parse accepts extremely deeply nested bodies, but the
  // recursive helpers then overflowed the call stack → RangeError → crash of the
  // shared gateway. A single deeply-nested create/exec/volume body sufficed.
  // The helpers must now fail-closed deny instead of throwing.
  const deep = (n: number): any => {
    let o: any = { x: 1 };
    for (let i = 0; i < n; i++) o = { a: o };
    return o;
  };
  it('findAmbiguousKey does not throw but fails closed on extremely deep nesting', () => {
    expect(() => findAmbiguousKey(deep(50000))).not.toThrow();
    expect(findAmbiguousKey(deep(50000))).not.toBeNull();
  });
  it('deepLowerKeys does not throw on extremely deep nesting', () => {
    expect(() => deepLowerKeys(deep(50000))).not.toThrow();
  });
  it('validators deny a deeply-nested body instead of crashing', () => {
    expect(validateHostConfig(deep(50000))).toMatch(/ambiguous|depth/);
    expect(validateExecConfig(deep(50000))).toMatch(/ambiguous|depth/);
    expect(validateVolumeCreate(deep(50000))).toMatch(/ambiguous|depth/);
  });
  it('normal-depth (legitimate) nesting keeps passing', () => {
    // A realistic docker create nests ~4-6 levels; well within the limit.
    expect(validateHostConfig({
      Mounts: [{ Type: 'volume', Source: 'v', VolumeOptions: { Labels: { a: 'b' } } }],
    }, OPEN)).toBeNull();
  });
});

describe('findAmbiguousKey', () => {
  it('detects a case-insensitive collision at one level', () => {
    expect(findAmbiguousKey({ HostConfig: {}, hostconfig: {} })).toBe('hostconfig');
    expect(findAmbiguousKey({ a: 1, A: 2 })).toBe('a');
  });
  it('detects nesting in objects and arrays', () => {
    expect(findAmbiguousKey({ x: { B: 1, b: 2 } })).toBe('b');
    expect(findAmbiguousKey([{ ok: 1 }, { X: 1, x: 2 }])).toBe('x');
  });
  it('returns null for an unambiguous structure', () => {
    expect(findAmbiguousKey({ HostConfig: { Privileged: true }, Cmd: ['sh'] })).toBeNull();
    expect(findAmbiguousKey(null)).toBeNull();
    expect(findAmbiguousKey('scalar')).toBeNull();
  });
});

describe('deepLowerKeys', () => {
  it('lowercases all object keys recursively, values stay intact', () => {
    expect(deepLowerKeys({ HostConfig: { Privileged: true, Binds: ['/:/host'] } }))
      .toEqual({ hostconfig: { privileged: true, binds: ['/:/host'] } });
  });
  it('leaves arrays and primitives untouched in value', () => {
    expect(deepLowerKeys({ Cmd: ['A', 'B'], N: 5, S: 'Keep' })).toEqual({ cmd: ['A', 'B'], n: 5, s: 'Keep' });
  });
});

describe('renameKeyCI — canonicalizes the keys the proxy injects into (PoC 1a)', () => {
  it('renames a top-level lowercase `hostconfig` to `HostConfig`', () => {
    // PoC 1a: the body carries only `hostconfig` (lowercase); the proxy also injected
    // a canonical `HostConfig` → two keys that the daemon merges.
    const body: any = { Image: 'x', hostconfig: { privileged: true, binds: ['/:/host'] } };
    renameKeyCI(body, 'HostConfig');
    expect(body.hostconfig).toBeUndefined();
    expect(body.HostConfig).toEqual({ privileged: true, binds: ['/:/host'] });
    // ...and the canonicalized HostConfig is then simply denied.
    expect(validateHostConfig(body.HostConfig)).toMatch(/Privileged/);
  });
  it('is a no-op if the key is already canonical or missing', () => {
    const a: any = { HostConfig: { Privileged: false } };
    renameKeyCI(a, 'HostConfig');
    expect(a).toEqual({ HostConfig: { Privileged: false } });
    const b: any = { Image: 'x' };
    renameKeyCI(b, 'HostConfig');
    expect(b).toEqual({ Image: 'x' });
  });
});
