import { describe, it, expect, vi } from 'vitest';

// ── Docker-socket-proxy: parser-differential-hardening ───────────────────────
// De Docker-daemon (Go encoding/json) matcht struct-velden HOOFDLETTER-ONGEVOELIG
// en merget dubbele sleutels. De oude proxy las sleutels hoofdlettergevoelig,
// waardoor de host-escape-PoC (poc-suite.sh: 1a/1b/1c/fs, exec #7, mask) élke
// HostConfig/exec-check omzeilde met een andere casing of een lege override.
//
// Deze suite dekt het pure validatie-hart: elke PoC-vector moet geweigerd worden
// ongeacht de casing, en legitiem (canoniek) verkeer moet blijven passeren.
//
// socket-proxy importeert db.ts alleen voor grant-checks; mocken houdt de native
// better-sqlite3-binding buiten deze test (zie rules.test.ts / socket-proxy.test.ts).
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

// Ruime mount-permissies zodat mount-toggles niet interfereren met de tests die
// juist de privilege/host-vectoren afdekken. Bind blijft dicht (host-path escape).
const OPEN: { bind: boolean; named: boolean; anonymous: boolean } = { bind: false, named: true, anonymous: true };

describe('validateHostConfig — privilege hard-denies zijn casing-agnostisch', () => {
  // Finding #1b/#1c: lowercase inner keys onder een correct gecapitaliseerde
  // (of lowercase) HostConfig.
  it('weigert Privileged in élke casing', () => {
    expect(validateHostConfig({ Privileged: true })).toMatch(/Privileged/);
    expect(validateHostConfig({ privileged: true })).toMatch(/Privileged/);
    expect(validateHostConfig({ PRIVILEGED: true })).toMatch(/Privileged/);
  });

  it('weigert PidMode=host in élke casing (PoC pop-calc vereist host PID ns)', () => {
    expect(validateHostConfig({ PidMode: 'host' })).toMatch(/PidMode/);
    expect(validateHostConfig({ pidmode: 'host' })).toMatch(/PidMode/);
  });

  it('weigert een host-path bind ongeacht de Binds-casing (PoC 1c: /:/host)', () => {
    expect(validateHostConfig({ Binds: ['/:/host'] })).toMatch(/bind/i);
    expect(validateHostConfig({ binds: ['/:/host'] })).toMatch(/bind/i);
  });

  it('weigert VolumesFrom / DeviceCgroupRules / DeviceRequests lowercase', () => {
    expect(validateHostConfig({ volumesfrom: ['other'] })).toMatch(/VolumesFrom/);
    expect(validateHostConfig({ devicecgrouprules: ['a *:* rwm'] })).toMatch(/DeviceCgroupRules/);
    expect(validateHostConfig({ devicerequests: [{ Count: -1 }] })).toMatch(/DeviceRequests/);
  });

  it('weigert een bind-type Mount met lowercase `type` (parser-differential in Mounts)', () => {
    expect(validateHostConfig({ Mounts: [{ Type: 'bind', Source: '/etc', Target: '/x' }] })).toMatch(/bind/i);
    expect(validateHostConfig({ mounts: [{ type: 'bind', source: '/etc', target: '/x' }] })).toMatch(/bind/i);
  });

  it('weigert een volume-mount met inline DriverConfig ongeacht casing', () => {
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', Source: 'v', VolumeOptions: { DriverConfig: { Name: 'local' } } }] }, OPEN))
      .toMatch(/DriverConfig/);
    expect(validateHostConfig({ mounts: [{ type: 'volume', source: 'v', volumeoptions: { driverconfig: { name: 'local' } } }] }, OPEN))
      .toMatch(/DriverConfig/);
  });
});

describe('validateHostConfig — mask/RO unmask (PoC `mask`)', () => {
  it('weigert een lege MaskedPaths (unmaskt /proc/kcore + sysrq-trigger)', () => {
    expect(validateHostConfig({ MaskedPaths: [] })).toMatch(/MaskedPaths/);
    expect(validateHostConfig({ maskedpaths: [] })).toMatch(/MaskedPaths/);
  });
  it('weigert een lege ReadonlyPaths', () => {
    expect(validateHostConfig({ ReadonlyPaths: [] })).toMatch(/ReadonlyPaths/);
    expect(validateHostConfig({ readonlypaths: [] })).toMatch(/ReadonlyPaths/);
  });
  it('weigert ook een niet-lege (afgeslankte) override', () => {
    expect(validateHostConfig({ MaskedPaths: ['/proc/keep'] })).toMatch(/MaskedPaths/);
  });
});

describe('validateHostConfig — case-insensitieve dubbele sleutels (Go merget dupes)', () => {
  it('weigert wanneer een gevaarlijke waarde onder een tweede casing meelift', () => {
    // Benign-eerst, evil-daarna
    expect(validateHostConfig({ Privileged: false, privileged: true })).toMatch(/ambiguous|Privileged/);
    // Evil-eerst, benign-daarna — mag NIET stil doorgelaten worden
    expect(validateHostConfig({ privileged: true, Privileged: false })).toMatch(/ambiguous|Privileged/);
  });
  it('weigert dubbele sleutels genest in Mounts', () => {
    expect(validateHostConfig({ Mounts: [{ Type: 'volume', type: 'bind' }] }, OPEN)).toMatch(/ambiguous/);
  });
});

describe('validateHostConfig — legitiem verkeer blijft passeren', () => {
  it('accepteert een gewone, veilige HostConfig (geen false positives)', () => {
    expect(validateHostConfig({
      NetworkMode: 'bridge',
      Memory: 0,
      RestartPolicy: { Name: '', MaximumRetryCount: 0 },
      AutoRemove: true,
      Binds: [],
      LogConfig: { Type: '', Config: {} },
    }, OPEN)).toBeNull();
  });
  it('accepteert expliciet false/leeg voor de hard-checked velden', () => {
    expect(validateHostConfig({ Privileged: false, PidMode: '', IpcMode: 'private', CapAdd: [] })).toBeNull();
  });
  it('accepteert een named-volume bind wanneer named toegestaan is', () => {
    expect(validateHostConfig({ Binds: ['myvol:/data'] }, OPEN)).toBeNull();
  });
});

describe('validateHostConfig — port-approval marker is casing-agnostisch', () => {
  it('geeft de __PORT_CHECK__ marker terug voor HostPort in élke casing', () => {
    expect(validateHostConfig({ PortBindings: { '3000/tcp': [{ HostPort: '3000' }] } }))
      .toBe('__PORT_CHECK__:3000:tcp');
    // lowercase `hostport` mocht de check vroeger ontwijken (hostPort=0 → geen marker)
    expect(validateHostConfig({ portbindings: { '3000/tcp': [{ hostport: '3000' }] } }))
      .toBe('__PORT_CHECK__:3000:tcp');
  });
});

describe('validateExecConfig — privileged exec (finding #7)', () => {
  it('weigert Privileged:true in élke casing', () => {
    expect(validateExecConfig({ Privileged: true, Cmd: ['/bin/sh'] })).toMatch(/Privileged/);
    expect(validateExecConfig({ privileged: true, Cmd: ['/bin/sh'] })).toMatch(/Privileged/);
  });
  it('weigert een dubbele Privileged-sleutel', () => {
    expect(validateExecConfig({ Privileged: true, privileged: false })).toMatch(/ambiguous|Privileged/);
  });
  it('laat een gewone (niet-privileged) exec door', () => {
    expect(validateExecConfig({ Cmd: ['/bin/sh', '-c', 'echo hi'], AttachStdout: true })).toBeNull();
    expect(validateExecConfig({ Privileged: false, Cmd: ['ls'] })).toBeNull();
  });
});

describe('validateVolumeCreate — bind-backed volume, casing-agnostisch', () => {
  it('weigert een local bind-backed volume ongeacht de DriverOpts-casing', () => {
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: { type: 'none', o: 'bind', device: '/' } }))
      .toMatch(/bind-backed/);
    // lowercase `driveropts` mocht de check vroeger ontwijken → nu ook geweigerd
    expect(validateVolumeCreate({ driver: 'local', driveropts: { type: 'none', o: 'bind', device: '/' } }))
      .toMatch(/bind-backed/);
  });
  it('weigert een dubbele DriverOpts-sleutel', () => {
    expect(validateVolumeCreate({ DriverOpts: { device: '/' }, driveropts: {} })).toMatch(/ambiguous/);
  });
  it('laat een gewoon named volume door', () => {
    expect(validateVolumeCreate({ Name: 'data' })).toBeNull();
    expect(validateVolumeCreate({ Driver: 'local', DriverOpts: {} })).toBeNull();
  });
});

describe('findAmbiguousKey', () => {
  it('detecteert een case-insensitieve botsing op één niveau', () => {
    expect(findAmbiguousKey({ HostConfig: {}, hostconfig: {} })).toBe('hostconfig');
    expect(findAmbiguousKey({ a: 1, A: 2 })).toBe('a');
  });
  it('detecteert nesting in objecten en arrays', () => {
    expect(findAmbiguousKey({ x: { B: 1, b: 2 } })).toBe('b');
    expect(findAmbiguousKey([{ ok: 1 }, { X: 1, x: 2 }])).toBe('x');
  });
  it('geeft null voor een eenduidige structuur', () => {
    expect(findAmbiguousKey({ HostConfig: { Privileged: true }, Cmd: ['sh'] })).toBeNull();
    expect(findAmbiguousKey(null)).toBeNull();
    expect(findAmbiguousKey('scalar')).toBeNull();
  });
});

describe('deepLowerKeys', () => {
  it('lowercased alle object-sleutels recursief, waarden blijven intact', () => {
    expect(deepLowerKeys({ HostConfig: { Privileged: true, Binds: ['/:/host'] } }))
      .toEqual({ hostconfig: { privileged: true, binds: ['/:/host'] } });
  });
  it('laat arrays en primitieven ongemoeid qua waarde', () => {
    expect(deepLowerKeys({ Cmd: ['A', 'B'], N: 5, S: 'Keep' })).toEqual({ cmd: ['A', 'B'], n: 5, s: 'Keep' });
  });
});

describe('renameKeyCI — canonicaliseert de sleutels waar de proxy in injecteert (PoC 1a)', () => {
  it('hernoemt een top-level lowercase `hostconfig` naar `HostConfig`', () => {
    // PoC 1a: de body draagt alleen `hostconfig` (lowercase); de proxy injecteerde
    // daarnaast een canonieke `HostConfig` → twee sleutels die de daemon merget.
    const body: any = { Image: 'x', hostconfig: { privileged: true, binds: ['/:/host'] } };
    renameKeyCI(body, 'HostConfig');
    expect(body.hostconfig).toBeUndefined();
    expect(body.HostConfig).toEqual({ privileged: true, binds: ['/:/host'] });
    // ...en de gecanonicaliseerde HostConfig wordt vervolgens gewoon geweigerd.
    expect(validateHostConfig(body.HostConfig)).toMatch(/Privileged/);
  });
  it('is een no-op als de sleutel al canoniek is of ontbreekt', () => {
    const a: any = { HostConfig: { Privileged: false } };
    renameKeyCI(a, 'HostConfig');
    expect(a).toEqual({ HostConfig: { Privileged: false } });
    const b: any = { Image: 'x' };
    renameKeyCI(b, 'HostConfig');
    expect(b).toEqual({ Image: 'x' });
  });
});
