import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'net';

// SSH relay: a plain TCP pipe host → devcontainer:22. A devcontainer can also
// reach the gateway, so connections from any container IP must be refused —
// otherwise container A could reach container B's sshd. Lookup errors fail closed.

const auditCalls: Array<{ containerId?: string | null; action?: string }> = [];
vi.mock('../src/db', () => ({
  logAudit: (e: { containerId?: string | null; action?: string }) => { auditCalls.push(e); },
}));

const { ensureSshRelay, closeSshRelay, sshRelayPort } = await import('../src/ssh-relay');

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

// Echo server standing in for sshd in the container.
async function echoServer(): Promise<{ port: number; server: net.Server }> {
  const server = net.createServer(sock => sock.pipe(sock));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as net.AddressInfo).port, server };
}

/** Connect, send `msg`, and resolve with what came back before the socket closed. */
function roundTrip(port: number, msg: string): Promise<string> {
  return new Promise((resolve) => {
    let got = '';
    const c = net.connect(port, '127.0.0.1', () => c.write(msg));
    c.on('data', d => { got += d.toString(); if (got.length >= msg.length) c.end(); });
    c.on('close', () => resolve(got));
    c.on('error', () => {});
  });
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  auditCalls.length = 0;
});

describe('ssh relay', () => {
  it('pipes host connections to the container', async () => {
    const echo = await echoServer();
    cleanup.push(() => new Promise(r => echo.server.close(() => r())));
    const port = await freePort();
    await ensureSshRelay('dc-a', port, {
      isContainerIp: async () => false,
      resolveTarget: async () => '127.0.0.1',
      targetPort: echo.port,
    });
    cleanup.push(() => closeSshRelay('dc-a'));

    expect(sshRelayPort('dc-a')).toBe(port);
    expect(await roundTrip(port, 'SSH-2.0-test\r\n')).toBe('SSH-2.0-test\r\n');
    expect(auditCalls).toContainEqual(expect.objectContaining({ containerId: 'dc-a', action: 'ssh:connect' }));
  });

  it.each([
    ['is a container', async () => true],
    ['cannot be checked', async () => { throw new Error('docker down'); }],
  ])('refuses the connection when the source IP %s', async (_label, isContainerIp) => {
    const resolveTarget = vi.fn(async () => '127.0.0.1');
    const port = await freePort();
    await ensureSshRelay('dc-b', port, { isContainerIp, resolveTarget, targetPort: 1 });
    cleanup.push(() => closeSshRelay('dc-b'));

    expect(await roundTrip(port, 'SSH-2.0-test\r\n')).toBe('');
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(auditCalls).toContainEqual(expect.objectContaining({ containerId: 'dc-b', action: 'ssh:deny-container-source' }));
  });

  it('closes the connection when the container is not running', async () => {
    const port = await freePort();
    await ensureSshRelay('dc-c', port, { isContainerIp: async () => false, resolveTarget: async () => null });
    cleanup.push(() => closeSshRelay('dc-c'));
    expect(await roundTrip(port, 'x')).toBe('');
  });

  it('closeSshRelay frees the port', async () => {
    const port = await freePort();
    await ensureSshRelay('dc-d', port, { isContainerIp: async () => false, resolveTarget: async () => null });
    await closeSshRelay('dc-d');
    expect(sshRelayPort('dc-d')).toBeNull();
    const s = net.createServer();
    await new Promise<void>((r, j) => { s.once('error', j); s.listen(port, () => r()); });
    await new Promise<void>(r => s.close(() => r()));
  });
});
