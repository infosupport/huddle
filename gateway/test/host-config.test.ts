import { describe, it, expect, vi } from 'vitest';

// socket-proxy imports db.ts only for the grant checks; mocking keeps the
// native better-sqlite3 binding out of this test (which is missing in a fresh
// DMZ devcontainer, see rules.test.ts / grants.test.ts). The tested functions
// are pure and do not touch the db.
vi.mock('../src/db', () => ({
  getGrant: () => null,
  isHostPortApproved: () => false,
}));

const { validateHostConfig, validateVolumeCreate } = await import('../src/socket-proxy');

// ── Boundary — socket-proxy HostConfig / volume policy ──────────────────────
// The per-container Docker socket proxy must block every attempt to break out of
// the devcontainer sandbox via a spawned container or via a volume.

describe('validateHostConfig', () => {
  it('allows an innocuous config', () => {
    // Volume mount kinds are off by default; test the shape acceptance with the
    // corresponding toggle on.
    const allowVols = { bind: false, named: true, anonymous: true };
    expect(validateHostConfig({})).toBeNull();
    expect(validateHostConfig({ Binds: ['myvol:/data'] }, allowVols)).toBeNull();
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', Source: 'myvol', Target: '/data' }] }, allowVols)).toBeNull();
  });

  it('denies the classic escape vectors', () => {
    expect(validateHostConfig({ Privileged: true })).toMatch(/privileged/i);
    expect(validateHostConfig({ PidMode: 'host' })).toMatch(/pidmode/i);
    expect(validateHostConfig({ CapAdd: ['SYS_ADMIN'] })).toMatch(/capadd/i);
    expect(validateHostConfig({ Binds: ['/:/host'] })).toMatch(/host-path bind/i);
    expect(validateHostConfig({ Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] })).toMatch(/bind-type/i);
  });

  it('denies a volume mount with inline driver config (local bind escape)', () => {
    const denial = validateHostConfig({
      Mounts: [{
        Type: 'volume',
        Target: '/host',
        VolumeOptions: { DriverConfig: { Name: 'local', Options: { type: 'none', device: '/', o: 'bind' } } },
      }],
    });
    expect(denial).toMatch(/driverconfig not permitted/i);
  });

  // ── Findings #1 / #2 — confirmed escape vectors (hard-deny) ──────────────
  it('denies HostConfig.VolumesFrom (finding #1 — inheriting huddle mounts)', () => {
    expect(validateHostConfig({ VolumesFrom: ['huddle'] })).toMatch(/volumesfrom not permitted/i);
    // Empty VolumesFrom (which the CLI sends by default) is INNOCUOUS.
    expect(validateHostConfig({ VolumesFrom: [] })).toBeNull();
  });
  it('denies HostConfig.DeviceCgroupRules (finding #2 — host raw-disk)', () => {
    expect(validateHostConfig({ DeviceCgroupRules: ['b 8:0 rwm'] })).toMatch(/devicecgrouprules not permitted/i);
    expect(validateHostConfig({ DeviceCgroupRules: [] })).toBeNull();
  });
  it('denies the rest of the device family (DeviceRequests, Blkio device limits)', () => {
    expect(validateHostConfig({ DeviceRequests: [{ Driver: 'nvidia', Count: -1 }] })).toMatch(/devicerequests not permitted/i);
    expect(validateHostConfig({ BlkioDeviceReadBps: [{ Path: '/dev/sda', Rate: 1 }] })).toMatch(/blkiodevicereadbps not permitted/i);
    expect(validateHostConfig({ BlkioDeviceWriteIOps: [{ Path: '/dev/sda', Rate: 1 }] })).toMatch(/blkiodevicewriteiops not permitted/i);
  });

  // ── Generic allowlist sweep over unknown fields ────────────────────────
  it('allows the zero/empty values that the Docker CLI sends by default', () => {
    // A representative `docker run`-like HostConfig with many default fields.
    const denial = validateHostConfig({
      NetworkMode: 'bridge',
      Memory: 0, CpuShares: 0, NanoCpus: 0,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      LogConfig: { Type: 'json-file', Config: {} },
      Binds: null, VolumesFrom: [], CapAdd: [], CapDrop: [], Devices: [],
      DeviceCgroupRules: [], Privileged: false, IpcMode: 'private',
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
      AutoRemove: true,
    });
    expect(denial).toBeNull();
  });
  // Parser-differential hardening: MaskedPaths/ReadonlyPaths are no longer legitimate
  // fields for a spawned container — an (empty or trimmed-down) override
  // weakens the daemon's secure defaults (PoC `mask`: /proc/kcore +
  // /proc/sysrq-trigger). Any present value is now denied.
  it('denies a MaskedPaths/ReadonlyPaths override (PoC `mask`)', () => {
    expect(validateHostConfig({ MaskedPaths: [] })).toMatch(/MaskedPaths/);
    expect(validateHostConfig({ MaskedPaths: ['/proc/kcore'] })).toMatch(/MaskedPaths/);
    expect(validateHostConfig({ ReadonlyPaths: [] })).toMatch(/ReadonlyPaths/);
  });
  it('log-only default: an unknown non-empty field is NOT denied', () => {
    delete process.env.HUDDLE_HOSTCONFIG_ENFORCE;
    expect(validateHostConfig({ SomeFutureField: { danger: true } })).toBeNull();
  });
  it('enforce mode: an unknown non-empty field is denied', () => {
    process.env.HUDDLE_HOSTCONFIG_ENFORCE = '1';
    try {
      expect(validateHostConfig({ SomeFutureField: { danger: true } })).toMatch(/not permitted: SomeFutureField/);
      // An unknown field with an empty value remains allowed, even in enforce.
      expect(validateHostConfig({ SomeFutureField: [] })).toBeNull();
    } finally {
      delete process.env.HUDDLE_HOSTCONFIG_ENFORCE;
    }
  });
  it('enforce mode does not break the legitimate create body', () => {
    process.env.HUDDLE_HOSTCONFIG_ENFORCE = '1';
    try {
      expect(validateHostConfig({
        NetworkMode: 'bridge', Memory: 536870912, CpuQuota: 200000, CpuPeriod: 100000,
        RestartPolicy: { Name: 'unless-stopped' }, Mounts: [{ Type: 'volume', Source: 'data', Target: '/data' }],
      }, { bind: false, named: true, anonymous: true })).toBeNull();
    } finally {
      delete process.env.HUDDLE_HOSTCONFIG_ENFORCE;
    }
  });
});

describe('validateHostConfig — mount permissions', () => {
  const allowAll = { bind: true, named: true, anonymous: true };
  const denyAll  = { bind: false, named: false, anonymous: false };

  it('defaults: all mount kinds denied (secure by default)', () => {
    expect(validateHostConfig({ Binds: ['/host:/data'] })).toMatch(/host-path bind/i);
    expect(validateHostConfig({ Binds: ['myvol:/data'] })).toMatch(/named volume/i);
    expect(validateHostConfig({ Binds: ['/data'] })).toMatch(/anonymous volume/i); // anonymous (no source)
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', Target: '/x' }] })).toMatch(/anonymous volume/i); // anonymous
  });

  it('bind toggle gates host-path binds (both Binds and Mounts)', () => {
    expect(validateHostConfig({ Binds: ['/host:/data'] }, allowAll)).toBeNull();
    expect(validateHostConfig({ Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] }, allowAll)).toBeNull();
    expect(validateHostConfig({ Binds: ['/host:/data'] }, denyAll)).toMatch(/host-path bind/i);
    expect(validateHostConfig({ Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] }, denyAll)).toMatch(/bind-type/i);
  });

  it('named toggle gates named volumes', () => {
    const perms = { bind: false, named: false, anonymous: true };
    expect(validateHostConfig({ Binds: ['myvol:/data'] }, perms)).toMatch(/named volume/i);
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', Source: 'myvol', Target: '/x' }] }, perms)).toMatch(/named volume/i);
  });

  it('anonymous toggle gates source-less volumes', () => {
    const perms = { bind: false, named: true, anonymous: false };
    expect(validateHostConfig({ Binds: ['/data'] }, perms)).toMatch(/anonymous volume/i);
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', Target: '/x' }] }, perms)).toMatch(/anonymous volume/i);
    // named still passes
    expect(validateHostConfig({ Binds: ['myvol:/data'] }, perms)).toBeNull();
  });

  it('DriverConfig volumes are always denied, even with all mounts allowed', () => {
    expect(validateHostConfig({
      Mounts: [{ Type: 'volume', Target: '/host', VolumeOptions: { DriverConfig: { Name: 'local' } } }],
    }, allowAll)).toMatch(/driverconfig not permitted/i);
  });
});

describe('validateVolumeCreate', () => {
  it('allows an ordinary named volume', () => {
    expect(validateVolumeCreate({ Name: 'data' })).toBeNull();
    expect(validateVolumeCreate({ Name: 'data', Driver: 'local' })).toBeNull();
    expect(validateVolumeCreate({ Name: 'data', Driver: 'local', DriverOpts: {} })).toBeNull();
  });

  it('denies a local bind-backed volume (host-path escape)', () => {
    expect(validateVolumeCreate({
      Name: 'hostroot', Driver: 'local',
      DriverOpts: { type: 'none', device: '/', o: 'bind' },
    })).toMatch(/bind-backed/i);
  });

  it('denies variants: only o=bind, only device, or type=none', () => {
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: { o: 'bind' } })).toMatch(/bind-backed/i);
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: { device: '/etc' } })).toMatch(/bind-backed/i);
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: { type: 'none' } })).toMatch(/bind-backed/i);
  });

  it('is case-insensitive on keys and values', () => {
    expect(validateVolumeCreate({ Driver: 'LOCAL', DriverOpts: { O: 'BIND' } })).toMatch(/bind-backed/i);
  });
});
