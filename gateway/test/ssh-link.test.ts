import { describe, it, expect, vi, beforeEach } from 'vitest';

// Connect IDE reserves a relay port first; a failure after that must give a port
// it reserved back, or failed attempts use up the 20-port pool.

const ports = new Map<string, number>();
const docker = vi.hoisted(() => ({
  inspectContainer: vi.fn(),
  execInContainer: vi.fn(),
  execContainerOutput: vi.fn(),
}));
const relay = vi.hoisted(() => ({ ensureSshRelay: vi.fn(), closeSshRelay: vi.fn() }));
const pipe = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('../src/docker', () => ({ ...docker, isContainerIp: vi.fn(), devcontainerIp: vi.fn() }));
vi.mock('../src/ssh-relay', () => relay);
vi.mock('../src/host-pipe', () => ({ hostPipe: pipe, HostPipeError: class extends Error { code = 'x'; } }));
vi.mock('../src/db', () => ({
  getSshRelayPort: (n: string) => ports.get(n) ?? null,
  listSshRelayPorts: () => [...ports].map(([container_name, port]) => ({ container_name, port })),
  setSshRelayPort: (n: string, p: number) => { ports.set(n, p); },
  deleteSshRelayPort: (n: string) => { ports.delete(n); },
}));

import { prepareSshLink } from '../src/ssh-link';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl huddle@host';

beforeEach(() => {
  ports.clear();
  vi.clearAllMocks();
  docker.inspectContainer.mockImplementation(async (name: string) => name === 'huddle'
    ? { HostConfig: { PortBindings: { '2200/tcp': [{}], '2201/tcp': [{}] } } }
    : { Id: 'abcdef123456', State: { Running: true }, Config: { Labels: { 'com.intellij.devcontainer.workspace.path': '/w' }, Env: [] } });
  docker.execInContainer.mockResolvedValue({ exitCode: 0 });
  docker.execContainerOutput.mockResolvedValue(`${KEY}\n`);
  relay.ensureSshRelay.mockResolvedValue(undefined);
  relay.closeSshRelay.mockResolvedValue(undefined);
  pipe.call.mockImplementation(async (op: string) => (op === 'ssh.key' ? { publicKey: KEY } : { publicKey: KEY }));
});

describe('prepareSshLink', () => {
  it('returns the Toolbox link to <name>.huddle and keeps the port', async () => {
    expect(await prepareSshLink('dc')).toBe('jetbrains://gateway/ssh/environment?h=dc.huddle&launchIde=true&projectHint=%2Fw');
    expect(ports.get('dc')).toBe(2200);
    expect(pipe.call).toHaveBeenCalledWith('ssh.host', { alias: 'dc.huddle', port: 2200, user: 'vscode', hostKey: KEY.split(' ').slice(0, 2).join(' ') });
  });

  it('gives back a port it reserved when a later step fails', async () => {
    docker.execInContainer.mockResolvedValue({ exitCode: 5 });
    await expect(prepareSshLink('dc')).rejects.toThrow(/sshd did not start/);
    expect(ports.has('dc')).toBe(false);
    expect(relay.closeSshRelay).toHaveBeenCalledWith('dc');
  });

  it('keeps a port the container already had', async () => {
    ports.set('dc', 2201);
    pipe.call.mockImplementation(async (op: string) => {
      if (op === 'ssh.host') throw new Error('disk full');
      return { publicKey: KEY };
    });
    await expect(prepareSshLink('dc')).rejects.toThrow(/disk full/);
    expect(ports.get('dc')).toBe(2201);
    expect(relay.closeSshRelay).not.toHaveBeenCalled();
  });
});
