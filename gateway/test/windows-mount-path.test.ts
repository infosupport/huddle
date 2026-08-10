import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ── Windows bind-mount source translation (issue #93) ───────────────────────
// `docker.ts` needs to translate a Windows workspace path (e.g. `Z:\temp\foo`)
// into whatever path the DOCKER ENGINE itself will accept as a bind-mount
// `Source`. That path is resolved by the engine's own mount namespace, which
// differs depending on how the engine is set up:
//  - dockerd running directly inside a WSL2 distro (no Docker Desktop) mounts
//    Windows drives at /mnt/<drive> — the previous (only) behavior.
//  - Docker Desktop runs dockerd inside its own hidden utility VM, which
//    exposes Windows drives at /run/desktop/mnt/host/<drive> instead. Passing
//    the /mnt/<drive> form there fails container creation with "bind source
//    path does not exist" (#93).
//
// docker.ts imports ./db (native better-sqlite3 binding, absent in a fresh
// devcontainer — see rules.test.ts) transitively via socket-proxy/sudo-grant,
// so it is mocked here purely to allow the module to load.
vi.mock('../src/db', () => ({
  getSetting: () => null,
  listFolderMappings: () => [],
  isHostPortApproved: () => false,
  getGrant: () => null,
  getActionPolicy: () => null,
  setSudoGrant: () => {},
  deleteSudoGrant: () => {},
  getExpiredSudoGrants: () => [],
}));

// dockerRequest() talks to the engine over http.request({ socketPath: ... }).
// Mocking 'http' lets us feed a fake /info response without a live daemon.
type FakeResponse = { statusCode?: number; body: string };
let nextResponse: FakeResponse = { statusCode: 200, body: '{}' };
let lastRequestOptions: any;

vi.mock('http', () => ({
  default: {
    request: (options: any, callback: (res: any) => void) => {
      lastRequestOptions = options;
      const res = new EventEmitter() as EventEmitter & { statusCode?: number };
      res.statusCode = nextResponse.statusCode;
      const req = new EventEmitter() as EventEmitter & { write: (s: string) => void; end: () => void };
      req.write = () => {};
      req.end = () => {
        queueMicrotask(() => {
          callback(res);
          res.emit('data', nextResponse.body);
          res.emit('end');
        });
      };
      return req;
    },
  },
}));

const { toLinuxPath, detectWindowsMountStyle } = await import('../src/docker');

beforeEach(() => {
  nextResponse = { statusCode: 200, body: '{}' };
});

describe('toLinuxPath', () => {
  it('leaves already-Linux paths untouched', () => {
    expect(toLinuxPath('/home/vscode/project')).toBe('/home/vscode/project');
    expect(toLinuxPath('/home/vscode/project', 'docker-desktop')).toBe('/home/vscode/project');
  });

  it('leaves non drive-letter input untouched (no match)', () => {
    expect(toLinuxPath('relative/path')).toBe('relative/path');
  });

  it('defaults to the /mnt/<drive> form (native WSL2 dockerd)', () => {
    expect(toLinuxPath('Z:\\temp\\huddle-test')).toBe('/mnt/z/temp/huddle-test');
    expect(toLinuxPath('C:/work/huddle-test')).toBe('/mnt/c/work/huddle-test');
  });

  it('uses /mnt/<drive> explicitly for the wsl2-native style', () => {
    expect(toLinuxPath('Z:\\temp\\huddle-test', 'wsl2-native')).toBe('/mnt/z/temp/huddle-test');
  });

  // Regression (#93): Docker Desktop's dockerd cannot resolve /mnt/<drive> —
  // it must use /run/desktop/mnt/host/<drive> instead.
  it('uses /run/desktop/mnt/host/<drive> for the docker-desktop style', () => {
    expect(toLinuxPath('Z:\\temp\\huddle-test', 'docker-desktop')).toBe('/run/desktop/mnt/host/z/temp/huddle-test');
    expect(toLinuxPath('C:/work/huddle-test', 'docker-desktop')).toBe('/run/desktop/mnt/host/c/work/huddle-test');
  });

  it('lowercases the drive letter', () => {
    expect(toLinuxPath('Z:\\temp\\huddle-test', 'docker-desktop')).toBe('/run/desktop/mnt/host/z/temp/huddle-test');
    expect(toLinuxPath('z:\\temp\\huddle-test', 'docker-desktop')).toBe('/run/desktop/mnt/host/z/temp/huddle-test');
  });
});

describe('detectWindowsMountStyle', () => {
  it('detects Docker Desktop from the /info OperatingSystem field', async () => {
    nextResponse = { statusCode: 200, body: JSON.stringify({ OperatingSystem: 'Docker Desktop' }) };
    expect(await detectWindowsMountStyle()).toBe('docker-desktop');
    expect(lastRequestOptions.path).toBe('/info');
  });

  it('treats any other OperatingSystem as native dockerd (WSL2 or Linux)', async () => {
    nextResponse = { statusCode: 200, body: JSON.stringify({ OperatingSystem: 'Ubuntu 22.04.3 LTS' }) };
    expect(await detectWindowsMountStyle()).toBe('wsl2-native');
  });

  it('falls back to wsl2-native if the engine cannot be reached', async () => {
    nextResponse = { statusCode: 500, body: '{"message":"boom"}' };
    expect(await detectWindowsMountStyle()).toBe('wsl2-native');
  });

  it('queries the engine fresh each call (no stale caching)', async () => {
    nextResponse = { statusCode: 200, body: JSON.stringify({ OperatingSystem: 'Docker Desktop' }) };
    expect(await detectWindowsMountStyle()).toBe('docker-desktop');
    nextResponse = { statusCode: 200, body: JSON.stringify({ OperatingSystem: 'Ubuntu 22.04.3 LTS' }) };
    expect(await detectWindowsMountStyle()).toBe('wsl2-native');
  });
});
