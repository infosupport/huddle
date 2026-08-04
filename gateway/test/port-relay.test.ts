import { describe, it, expect, vi } from 'vitest';
import net from 'net';
import type { AddressInfo } from 'net';
import { EventEmitter } from 'events';

// socket-proxy imports db.ts only for the grant checks; mocking it keeps the
// native better-sqlite3 binding out of this test (see container-ownership.test.ts).
vi.mock('../src/db', () => ({
  getGrant: () => null,
  isHostPortApproved: () => false,
}));

const {
  extractRelaySpecs, resolveTarget, buildForwarderSetupScript,
  createNetworkRefTracker, ipInSubnet, dialWithTimeout,
  assertSafeOwner, syncContainerRelays, ensurePortForwarder,
} = await import('../src/port-relay');
const { parseHttpStatus } = await import('../src/socket-proxy');

// ── Relay specs from a container inspect ─────────────────────────────────────
// The relay mirrors the ports the docker daemon bound on the HOST into the
// devcontainer's loopback. The source is NetworkSettings.Ports after start, so
// that dynamically assigned ports (HostPort:0 in the create) are picked up too.
describe('extractRelaySpecs', () => {
  it('extracts a published tcp binding', () => {
    const inspect = {
      NetworkSettings: {
        Ports: { '1433/tcp': [{ HostIp: '127.0.0.1', HostPort: '32769' }] },
      },
    };
    expect(extractRelaySpecs(inspect)).toEqual([{ hostPort: 32769, containerPort: 1433, proto: 'tcp' }]);
  });

  it('deduplicates v4/v6 bindings of the same host port', () => {
    const inspect = {
      NetworkSettings: {
        Ports: {
          '80/tcp': [
            { HostIp: '0.0.0.0', HostPort: '8080' },
            { HostIp: '::', HostPort: '8080' },
          ],
        },
      },
    };
    expect(extractRelaySpecs(inspect)).toEqual([{ hostPort: 8080, containerPort: 80, proto: 'tcp' }]);
  });

  it('skips unpublished (null) ports', () => {
    const inspect = { NetworkSettings: { Ports: { '1433/tcp': null } } };
    expect(extractRelaySpecs(inspect)).toEqual([]);
  });

  it('skips bindings without a usable HostPort', () => {
    const inspect = {
      NetworkSettings: {
        Ports: { '1433/tcp': [{ HostIp: '', HostPort: '' }, { HostPort: '0' }] },
      },
    };
    expect(extractRelaySpecs(inspect)).toEqual([]);
  });

  it('returns udp bindings with their proto so the caller can log them', () => {
    const inspect = {
      NetworkSettings: {
        Ports: { '53/udp': [{ HostIp: '0.0.0.0', HostPort: '5353' }] },
      },
    };
    expect(extractRelaySpecs(inspect)).toEqual([{ hostPort: 5353, containerPort: 53, proto: 'udp' }]);
  });

  it('tolerates an inspect without a ports section', () => {
    expect(extractRelaySpecs({})).toEqual([]);
    expect(extractRelaySpecs(null)).toEqual([]);
    expect(extractRelaySpecs({ NetworkSettings: {} })).toEqual([]);
  });
});

// ── Target (network + IP) of the workload container ──────────────────────────
// The gateway reaches the workload via the owner's dc-net when it can; if the
// workload lives only on a network of its own (Aspire session-net), that
// network is returned instead so the caller attaches the gateway to it first —
// between non-shared bridges Docker silently DROPs SYNs.
describe('resolveTarget', () => {
  it("picks the owner's dc-net when the workload is on it", () => {
    const inspect = {
      NetworkSettings: {
        Networks: {
          'ander-net': { IPAddress: '10.0.0.2' },
          'dc-net-dc-a': { IPAddress: '192.168.16.2' },
        },
      },
    };
    expect(resolveTarget(inspect, 'dc-a')).toEqual({ ip: '192.168.16.2', network: 'dc-net-dc-a' });
  });

  it('otherwise returns the workload network (join required)', () => {
    const inspect = {
      NetworkSettings: { Networks: { 'aspire-session-net': { IPAddress: '10.0.0.2' } } },
    };
    expect(resolveTarget(inspect, 'dc-a')).toEqual({ ip: '10.0.0.2', network: 'aspire-session-net' });
  });

  it('returns null without a usable network', () => {
    expect(resolveTarget({}, 'dc-a')).toBeNull();
    expect(resolveTarget({ NetworkSettings: { Networks: { x: { IPAddress: '' } } } }, 'dc-a')).toBeNull();
  });
});

// ── Forwarder setup script ───────────────────────────────────────────────────
describe('buildForwarderSetupScript', () => {
  const script = buildForwarderSetupScript();

  it('installs the forwarder and makes host.docker.internal loopback', () => {
    expect(script).toContain('/usr/local/lib/huddle-port-forwarder.js');
    expect(script).toContain("echo '127.0.0.1 host.docker.internal' >> /etc/hosts");
  });

  it('ships the forwarder as valid base64 with the loopback listeners', () => {
    const b64 = script.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] ?? '';
    const js = Buffer.from(b64, 'base64').toString('utf8');
    expect(js).toContain('/var/run/huddle/ports');
    expect(js).toContain("'127.0.0.1'");
    expect(js).toContain("'::1'");
    // The ready/err files are the handshake channel with the gateway
    // (waitForForwarderReady); without those markers a dynamic-port start races.
    expect(js).toContain(".ready'");
    expect(js).toContain(".err'");
  });

  it('is idempotent: restarts only on a changed script or dead pid', () => {
    expect(script).toContain('cmp -s');
    expect(script).toContain('kill -0');
  });
});

// ── Network join + refcount ──────────────────────────────────────────────────
// The gateway joins workload networks on demand and must detach again as soon
// as the last relay on that network disappears — otherwise it blocks
// `docker network rm` during Aspire's cleanup. Networks it was already
// attached to (already-connected) and permanent ones (dc-net-*) are never
// disconnected.
describe('createNetworkRefTracker', () => {
  function fakeOps(connectResult: () => 'connected' | 'already-connected' | 'missing' | 'error') {
    const calls = { connect: 0, disconnect: 0 };
    const ops = {
      connect: async () => { calls.connect++; return connectResult(); },
      disconnect: async () => { calls.disconnect++; },
      subnets: async () => ['10.10.0.0/24'],
    };
    return { ops, calls };
  }

  it('fresh join: connect once, disconnect only on the last release', async () => {
    const { ops, calls } = fakeOps(() => 'connected' as const);
    const t = createNetworkRefTracker(ops);
    expect(await t.acquire('net-a', 'ct-1')).toBe(true);
    expect(await t.acquire('net-a', 'ct-2')).toBe(true);
    expect(calls.connect).toBe(1); // second acquire is purely a refcount
    await t.release('net-a', 'ct-1');
    expect(calls.disconnect).toBe(0); // ct-2 still holds the network
    expect(t.isJoined('net-a')).toBe(true);
    await t.release('net-a', 'ct-2');
    expect(calls.disconnect).toBe(1);
    expect(t.isJoined('net-a')).toBe(false);
  });

  it('already-connected: success, but never a disconnect (membership was not ours)', async () => {
    const { ops, calls } = fakeOps(() => 'already-connected' as const);
    const t = createNetworkRefTracker(ops);
    expect(await t.acquire('net-a', 'ct-1')).toBe(true);
    await t.release('net-a', 'ct-1');
    expect(calls.disconnect).toBe(0);
  });

  it('vanished network: acquire fails without registering', async () => {
    const { ops } = fakeOps(() => 'missing' as const);
    const t = createNetworkRefTracker(ops);
    expect(await t.acquire('net-gone', 'ct-1')).toBe(false);
    expect(t.isJoined('net-gone')).toBe(false);
  });

  it('permanent networks (dc-net-*) are never disconnected', async () => {
    const { ops, calls } = fakeOps(() => 'connected' as const);
    const t = createNetworkRefTracker(ops);
    await t.acquire('dc-net-dc-a', 'ct-1');
    await t.release('dc-net-dc-a', 'ct-1');
    expect(calls.disconnect).toBe(0);
  });

  it('isJoinedNetworkIp matches only subnets of networks WE joined', async () => {
    const { ops } = fakeOps(() => 'connected' as const);
    const t = createNetworkRefTracker(ops);
    await t.acquire('net-a', 'ct-1');
    expect(t.isJoinedNetworkIp('10.10.0.7')).toBe(true);
    expect(t.isJoinedNetworkIp('::ffff:10.10.0.7')).toBe(true);
    expect(t.isJoinedNetworkIp('10.11.0.7')).toBe(false);

    // already-connected (pre-existing membership, e.g. the default net) must
    // NOT trigger the :3000 guard.
    const pre = fakeOps(() => 'already-connected' as const);
    const t2 = createNetworkRefTracker(pre.ops);
    await t2.acquire('net-b', 'ct-1');
    expect(t2.isJoinedNetworkIp('10.10.0.7')).toBe(false);
  });
});

describe('ipInSubnet', () => {
  it('matches IPv4 CIDR boundaries correctly', () => {
    expect(ipInSubnet('192.168.16.2', '192.168.16.0/20')).toBe(true);
    expect(ipInSubnet('192.168.31.255', '192.168.16.0/20')).toBe(true);
    expect(ipInSubnet('192.168.32.1', '192.168.16.0/20')).toBe(false);
    expect(ipInSubnet('::ffff:192.168.16.2', '192.168.16.0/20')).toBe(true);
  });

  it('conservatively does not match unusable input (IPv6, garbage)', () => {
    expect(ipInSubnet('fd00::2', 'fd00::/64')).toBe(false);
    expect(ipInSubnet('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipInSubnet('10.0.0.1', 'garbage')).toBe(false);
  });
});

// ── Backend dial with timeout ────────────────────────────────────────────────
// Docker's inter-bridge isolation drops SYNs without an RST: without a hard
// timeout a relay client hangs forever on an accept that never yields bytes.
describe('dialWithTimeout', () => {
  it('connects to a listening port', async () => {
    const srv = net.createServer(c => c.end());
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const port = (srv.address() as AddressInfo).port;
    const sock = await dialWithTimeout('127.0.0.1', port, 1000);
    sock.destroy();
    srv.close();
  });

  it('rejects (no hang) on a closed port', async () => {
    // Reserve a port and close it again → guaranteed closed.
    const srv = net.createServer();
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((res) => srv.close(() => res()));
    await expect(dialWithTimeout('127.0.0.1', port, 1000)).rejects.toThrow();
  });

  it('timeout: a dial that never connects rejects + destroys (the inter-bridge DROP scenario)', async () => {
    // Mocked socket that never emits 'connect' — a deterministic equivalent of
    // Docker's silent SYN drop between bridges (a real blackhole address is
    // not reliable in a sandbox/CI network).
    const fake = new EventEmitter() as any;
    fake.destroy = vi.fn();
    const spy = vi.spyOn(net, 'createConnection').mockReturnValue(fake);
    try {
      await expect(dialWithTimeout('10.255.0.1', 1433, 50)).rejects.toThrow(/timeout/);
      expect(fake.destroy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── HTTP status parser for buffered responses ────────────────────────────────
// openUpstreamBuffered (socket-proxy.ts) uses this status to decide whether
// relays are set up or torn down before the response goes back to the client.
describe('parseHttpStatus', () => {
  it('reads the status code from an HTTP/1.1 response', () => {
    expect(parseHttpStatus(Buffer.from('HTTP/1.1 204 No Content\r\n\r\n'))).toBe(204);
    expect(parseHttpStatus(Buffer.from('HTTP/1.0 404 Not Found\r\n\r\n'))).toBe(404);
  });

  it('returns 0 for an unrecognizable response', () => {
    expect(parseHttpStatus(Buffer.from(''))).toBe(0);
    expect(parseHttpStatus(Buffer.from('garbage'))).toBe(0);
  });
});

// ── Owner-name guard on the relay entry points ───────────────────────────────
// `owner` flows into path.join() under the shared sockets directory. Same
// Docker name grammar as assertSafeContainerName (socket-proxy.ts): a
// traversal name must never lead to a path outside that directory — not even
// via the operator API (`/api/docker/containers/:name/start`).
describe('assertSafeOwner', () => {
  it('accepts valid Docker container names', () => {
    for (const ok of ['devcontainer-aspire', 'a', 'A1_b.c-d']) {
      expect(() => assertSafeOwner(ok)).not.toThrow();
    }
  });

  it('rejects traversal and non-grammar names', () => {
    for (const bad of ['../evil', 'a/b', '.hidden', '', '..', 'a b']) {
      expect(() => assertSafeOwner(bad)).toThrow(/unsafe owner name/);
    }
  });

  it('fires before any I/O on both public entry points', async () => {
    await expect(syncContainerRelays('../evil', 'x')).rejects.toThrow(/unsafe owner name/);
    await expect(ensurePortForwarder('../evil')).rejects.toThrow(/unsafe owner name/);
  });
});
