import { describe, it, expect, vi } from 'vitest';

// socket-proxy importeert db.ts alleen voor de grant-checks; mocken houdt de
// native better-sqlite3-binding buiten deze test (die ontbreekt in een verse
// DMZ-devcontainer, zie rules.test.ts / grants.test.ts). De geteste functies
// zijn puur en raken de db niet.
vi.mock('../src/db', () => ({
  getGrant: () => null,
  isHostPortApproved: () => false,
}));

const { validateHostConfig, validateVolumeCreate } = await import('../src/socket-proxy');

// ── Boundary — socket-proxy HostConfig / volume policy ──────────────────────
// De per-container Docker-socket-proxy moet elke poging blokkeren om via een
// gespawnde container of via een volume uit de devcontainer-sandbox te breken.

describe('validateHostConfig', () => {
  it('staat een onschuldige config toe', () => {
    // Volume-mount-soorten staan standaard uit; test de shape-acceptatie met de
    // bijbehorende toggle aan.
    const allowVols = { bind: false, named: true, anonymous: true };
    expect(validateHostConfig({})).toBeNull();
    expect(validateHostConfig({ Binds: ['myvol:/data'] }, allowVols)).toBeNull();
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', Source: 'myvol', Target: '/data' }] }, allowVols)).toBeNull();
  });

  it('weigert de klassieke escape-vectoren', () => {
    expect(validateHostConfig({ Privileged: true })).toMatch(/privileged/i);
    expect(validateHostConfig({ PidMode: 'host' })).toMatch(/pidmode/i);
    expect(validateHostConfig({ CapAdd: ['SYS_ADMIN'] })).toMatch(/capadd/i);
    expect(validateHostConfig({ Binds: ['/:/host'] })).toMatch(/host-path bind/i);
    expect(validateHostConfig({ Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] })).toMatch(/bind-type/i);
  });

  it('weigert een volume-mount met inline driver-config (local bind escape)', () => {
    const denial = validateHostConfig({
      Mounts: [{
        Type: 'volume',
        Target: '/host',
        VolumeOptions: { DriverConfig: { Name: 'local', Options: { type: 'none', device: '/', o: 'bind' } } },
      }],
    });
    expect(denial).toMatch(/driverconfig not permitted/i);
  });

  // ── Findings #1 / #2 — bevestigde escape-vectoren (hard-deny) ──────────────
  it('weigert HostConfig.VolumesFrom (finding #1 — erven van huddle-mounts)', () => {
    expect(validateHostConfig({ VolumesFrom: ['huddle'] })).toMatch(/volumesfrom not permitted/i);
    // Lege VolumesFrom (wat de CLI standaard meestuurt) is ONSCHULDIG.
    expect(validateHostConfig({ VolumesFrom: [] })).toBeNull();
  });
  it('weigert HostConfig.DeviceCgroupRules (finding #2 — host raw-disk)', () => {
    expect(validateHostConfig({ DeviceCgroupRules: ['b 8:0 rwm'] })).toMatch(/devicecgrouprules not permitted/i);
    expect(validateHostConfig({ DeviceCgroupRules: [] })).toBeNull();
  });
  it('weigert de rest van de device-familie (DeviceRequests, Blkio device-limieten)', () => {
    expect(validateHostConfig({ DeviceRequests: [{ Driver: 'nvidia', Count: -1 }] })).toMatch(/devicerequests not permitted/i);
    expect(validateHostConfig({ BlkioDeviceReadBps: [{ Path: '/dev/sda', Rate: 1 }] })).toMatch(/blkiodevicereadbps not permitted/i);
    expect(validateHostConfig({ BlkioDeviceWriteIOps: [{ Path: '/dev/sda', Rate: 1 }] })).toMatch(/blkiodevicewriteiops not permitted/i);
  });

  // ── Generieke allowlist-sweep over onbekende velden ────────────────────────
  it('staat de nul-/lege waarden toe die de Docker-CLI standaard meestuurt', () => {
    // Een representatieve `docker run`-achtige HostConfig met veel default-velden.
    const denial = validateHostConfig({
      NetworkMode: 'bridge',
      Memory: 0, CpuShares: 0, NanoCpus: 0,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      LogConfig: { Type: 'json-file', Config: {} },
      Binds: null, VolumesFrom: [], CapAdd: [], CapDrop: [], Devices: [],
      DeviceCgroupRules: [], Privileged: false, IpcMode: 'private',
      MaskedPaths: ['/proc/kcore'], ReadonlyPaths: ['/proc/sysrq-trigger'],
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
      AutoRemove: true,
    });
    expect(denial).toBeNull();
  });
  it('log-only default: een onbekend niet-leeg veld wordt NIET geweigerd', () => {
    delete process.env.HUDDLE_HOSTCONFIG_ENFORCE;
    expect(validateHostConfig({ SomeFutureField: { danger: true } })).toBeNull();
  });
  it('enforce-mode: een onbekend niet-leeg veld wordt geweigerd', () => {
    process.env.HUDDLE_HOSTCONFIG_ENFORCE = '1';
    try {
      expect(validateHostConfig({ SomeFutureField: { danger: true } })).toMatch(/not permitted: SomeFutureField/);
      // Een onbekend veld met een lege waarde blijft toegestaan, ook in enforce.
      expect(validateHostConfig({ SomeFutureField: [] })).toBeNull();
    } finally {
      delete process.env.HUDDLE_HOSTCONFIG_ENFORCE;
    }
  });
  it('enforce-mode breekt de legitieme create-body niet', () => {
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

  it('defaults: alle mount-soorten geweigerd (secure by default)', () => {
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
  it('staat een gewoon named volume toe', () => {
    expect(validateVolumeCreate({ Name: 'data' })).toBeNull();
    expect(validateVolumeCreate({ Name: 'data', Driver: 'local' })).toBeNull();
    expect(validateVolumeCreate({ Name: 'data', Driver: 'local', DriverOpts: {} })).toBeNull();
  });

  it('weigert een local bind-backed volume (host-path escape)', () => {
    expect(validateVolumeCreate({
      Name: 'hostroot', Driver: 'local',
      DriverOpts: { type: 'none', device: '/', o: 'bind' },
    })).toMatch(/bind-backed/i);
  });

  it('weigert varianten: alleen o=bind, alleen device, of type=none', () => {
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: { o: 'bind' } })).toMatch(/bind-backed/i);
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: { device: '/etc' } })).toMatch(/bind-backed/i);
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: { type: 'none' } })).toMatch(/bind-backed/i);
  });

  it('is case-insensitief op sleutels en waarden', () => {
    expect(validateVolumeCreate({ Driver: 'LOCAL', DriverOpts: { O: 'BIND' } })).toMatch(/bind-backed/i);
  });
});
