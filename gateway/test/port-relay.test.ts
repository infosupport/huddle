import { describe, it, expect, vi } from 'vitest';
import net from 'net';
import type { AddressInfo } from 'net';
import { EventEmitter } from 'events';

// socket-proxy importeert db.ts alleen voor de grant-checks; mocken houdt de
// native better-sqlite3-binding buiten deze test (zie container-ownership.test.ts).
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

// ── Relay-specs uit een container-inspect ────────────────────────────────────
// De relay spiegelt de poorten die de docker-daemon op de HOST bond naar de
// loopback van de devcontainer. Bron is NetworkSettings.Ports ná start, zodat
// ook dynamisch toegewezen poorten (HostPort:0 in de create) meegenomen worden.
describe('extractRelaySpecs', () => {
  it('leest een gepubliceerde tcp-binding uit', () => {
    const inspect = {
      NetworkSettings: {
        Ports: { '1433/tcp': [{ HostIp: '127.0.0.1', HostPort: '32769' }] },
      },
    };
    expect(extractRelaySpecs(inspect)).toEqual([{ hostPort: 32769, containerPort: 1433, proto: 'tcp' }]);
  });

  it('voegt dubbele v4/v6-bindings van dezelfde hostpoort samen', () => {
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

  it('slaat niet-gepubliceerde (null) poorten over', () => {
    const inspect = { NetworkSettings: { Ports: { '1433/tcp': null } } };
    expect(extractRelaySpecs(inspect)).toEqual([]);
  });

  it('slaat bindings zonder bruikbare HostPort over', () => {
    const inspect = {
      NetworkSettings: {
        Ports: { '1433/tcp': [{ HostIp: '', HostPort: '' }, { HostPort: '0' }] },
      },
    };
    expect(extractRelaySpecs(inspect)).toEqual([]);
  });

  it('geeft udp-bindings terug mét proto zodat de caller ze kan loggen', () => {
    const inspect = {
      NetworkSettings: {
        Ports: { '53/udp': [{ HostIp: '0.0.0.0', HostPort: '5353' }] },
      },
    };
    expect(extractRelaySpecs(inspect)).toEqual([{ hostPort: 5353, containerPort: 53, proto: 'udp' }]);
  });

  it('verdraagt een inspect zonder poortsectie', () => {
    expect(extractRelaySpecs({})).toEqual([]);
    expect(extractRelaySpecs(null)).toEqual([]);
    expect(extractRelaySpecs({ NetworkSettings: {} })).toEqual([]);
  });
});

// ── Doel (netwerk + IP) van de workload-container ────────────────────────────
// De gateway bereikt de workload via het dc-net van de eigenaar als dat kan;
// leeft de workload alleen op een eigen netwerk (Aspire session-net), dan komt
// dát netwerk terug zodat de caller de gateway er eerst aan koppelt — tussen
// niet-gedeelde bridges DROP't Docker SYN's geluidloos.
describe('resolveTarget', () => {
  it('kiest het dc-net van de eigenaar als de workload daarop zit', () => {
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

  it('geeft anders het workload-netwerk terug (join vereist)', () => {
    const inspect = {
      NetworkSettings: { Networks: { 'aspire-session-net': { IPAddress: '10.0.0.2' } } },
    };
    expect(resolveTarget(inspect, 'dc-a')).toEqual({ ip: '10.0.0.2', network: 'aspire-session-net' });
  });

  it('geeft null zonder bruikbaar netwerk', () => {
    expect(resolveTarget({}, 'dc-a')).toBeNull();
    expect(resolveTarget({ NetworkSettings: { Networks: { x: { IPAddress: '' } } } }, 'dc-a')).toBeNull();
  });
});

// ── Forwarder-setupscript ────────────────────────────────────────────────────
describe('buildForwarderSetupScript', () => {
  const script = buildForwarderSetupScript();

  it('installeert de forwarder en maakt host.docker.internal loopback', () => {
    expect(script).toContain('/usr/local/lib/huddle-port-forwarder.js');
    expect(script).toContain("echo '127.0.0.1 host.docker.internal' >> /etc/hosts");
  });

  it('levert de forwarder als geldige base64 met de loopback-listeners', () => {
    const b64 = script.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] ?? '';
    const js = Buffer.from(b64, 'base64').toString('utf8');
    expect(js).toContain('/var/run/huddle/ports');
    expect(js).toContain("'127.0.0.1'");
    expect(js).toContain("'::1'");
    // De ready-/err-bestanden zijn het handshake-kanaal met de gateway
    // (waitForForwarderReady); zonder die markers racet een dynamic-port start.
    expect(js).toContain(".ready'");
    expect(js).toContain(".err'");
  });

  it('is idempotent: herstart alleen bij een gewijzigd script of dode pid', () => {
    expect(script).toContain('cmp -s');
    expect(script).toContain('kill -0');
  });
});

// ── Netwerk-join + refcount ──────────────────────────────────────────────────
// De gateway joint workload-netwerken on demand en moet zich weer loskoppelen
// zodra de laatste relay op dat netwerk verdwijnt — anders blokkeert hij
// `docker network rm` bij Aspire's cleanup. Netwerken waar hij al aan hing
// (already-connected) en permanente (dc-net-*) worden nooit losgekoppeld.
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

  it('verse join: connect één keer, disconnect pas bij de laatste release', async () => {
    const { ops, calls } = fakeOps(() => 'connected' as const);
    const t = createNetworkRefTracker(ops);
    expect(await t.acquire('net-a', 'ct-1')).toBe(true);
    expect(await t.acquire('net-a', 'ct-2')).toBe(true);
    expect(calls.connect).toBe(1); // tweede acquire is puur een refcount
    await t.release('net-a', 'ct-1');
    expect(calls.disconnect).toBe(0); // ct-2 houdt het netwerk nog vast
    expect(t.isJoined('net-a')).toBe(true);
    await t.release('net-a', 'ct-2');
    expect(calls.disconnect).toBe(1);
    expect(t.isJoined('net-a')).toBe(false);
  });

  it('already-connected: succes, maar nooit een disconnect (membership was niet van ons)', async () => {
    const { ops, calls } = fakeOps(() => 'already-connected' as const);
    const t = createNetworkRefTracker(ops);
    expect(await t.acquire('net-a', 'ct-1')).toBe(true);
    await t.release('net-a', 'ct-1');
    expect(calls.disconnect).toBe(0);
  });

  it('verdwenen netwerk: acquire faalt zonder te registreren', async () => {
    const { ops } = fakeOps(() => 'missing' as const);
    const t = createNetworkRefTracker(ops);
    expect(await t.acquire('net-gone', 'ct-1')).toBe(false);
    expect(t.isJoined('net-gone')).toBe(false);
  });

  it('permanente netwerken (dc-net-*) worden nooit losgekoppeld', async () => {
    const { ops, calls } = fakeOps(() => 'connected' as const);
    const t = createNetworkRefTracker(ops);
    await t.acquire('dc-net-dc-a', 'ct-1');
    await t.release('dc-net-dc-a', 'ct-1');
    expect(calls.disconnect).toBe(0);
  });

  it('isJoinedNetworkIp matcht alleen subnetten van door óns gejoinde netwerken', async () => {
    const { ops } = fakeOps(() => 'connected' as const);
    const t = createNetworkRefTracker(ops);
    await t.acquire('net-a', 'ct-1');
    expect(t.isJoinedNetworkIp('10.10.0.7')).toBe(true);
    expect(t.isJoinedNetworkIp('::ffff:10.10.0.7')).toBe(true);
    expect(t.isJoinedNetworkIp('10.11.0.7')).toBe(false);

    // already-connected (pre-existing membership, bv. het default-net) mag de
    // :3000-guard níet triggeren.
    const pre = fakeOps(() => 'already-connected' as const);
    const t2 = createNetworkRefTracker(pre.ops);
    await t2.acquire('net-b', 'ct-1');
    expect(t2.isJoinedNetworkIp('10.10.0.7')).toBe(false);
  });
});

describe('ipInSubnet', () => {
  it('matcht IPv4 CIDR-grenzen correct', () => {
    expect(ipInSubnet('192.168.16.2', '192.168.16.0/20')).toBe(true);
    expect(ipInSubnet('192.168.31.255', '192.168.16.0/20')).toBe(true);
    expect(ipInSubnet('192.168.32.1', '192.168.16.0/20')).toBe(false);
    expect(ipInSubnet('::ffff:192.168.16.2', '192.168.16.0/20')).toBe(true);
  });

  it('matcht conservatief niet op onbruikbare invoer (IPv6, rommel)', () => {
    expect(ipInSubnet('fd00::2', 'fd00::/64')).toBe(false);
    expect(ipInSubnet('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipInSubnet('10.0.0.1', 'garbage')).toBe(false);
  });
});

// ── Backend-dial met timeout ─────────────────────────────────────────────────
// Docker's inter-bridge-isolatie dropt SYN's zonder RST: zonder harde timeout
// hangt een relay-client voor eeuwig op accept-zonder-bytes.
describe('dialWithTimeout', () => {
  it('verbindt naar een luisterende poort', async () => {
    const srv = net.createServer(c => c.end());
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const port = (srv.address() as AddressInfo).port;
    const sock = await dialWithTimeout('127.0.0.1', port, 1000);
    sock.destroy();
    srv.close();
  });

  it('reject (geen hang) op een gesloten poort', async () => {
    // Poort reserveren en weer sluiten → gegarandeerd dicht.
    const srv = net.createServer();
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((res) => srv.close(() => res()));
    await expect(dialWithTimeout('127.0.0.1', port, 1000)).rejects.toThrow();
  });

  it('timeout: een dial die nooit connect geeft reject + destroy (het inter-bridge-DROP-scenario)', async () => {
    // Gemockte socket die nooit 'connect' emit — deterministisch equivalent van
    // Docker's stille SYN-drop tussen bridges (een echt blackhole-adres is in
    // een sandbox/CI-netwerk niet betrouwbaar).
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

// ── HTTP-statusparser voor gebufferde responsen ──────────────────────────────
// openUpstreamBuffered (socket-proxy.ts) beslist op deze status of relays
// opgezet/afgebroken worden voordat de respons naar de client teruggaat.
describe('parseHttpStatus', () => {
  it('leest de statuscode uit een HTTP/1.1-respons', () => {
    expect(parseHttpStatus(Buffer.from('HTTP/1.1 204 No Content\r\n\r\n'))).toBe(204);
    expect(parseHttpStatus(Buffer.from('HTTP/1.0 404 Not Found\r\n\r\n'))).toBe(404);
  });

  it('geeft 0 voor een onherkenbaar antwoord', () => {
    expect(parseHttpStatus(Buffer.from(''))).toBe(0);
    expect(parseHttpStatus(Buffer.from('garbage'))).toBe(0);
  });
});

// ── Owner-naamguard op de relay-entry-points ─────────────────────────────────
// `owner` vloeit in path.join() onder de gedeelde sockets-directory. Dezelfde
// Docker-naamgrammatica als assertSafeContainerName (socket-proxy.ts): een
// traversal-naam mag nooit tot een pad buiten die directory leiden — ook niet
// via de operator-API (`/api/docker/containers/:name/start`).
describe('assertSafeOwner', () => {
  it('accepteert geldige Docker-containernamen', () => {
    for (const ok of ['devcontainer-aspire', 'a', 'A1_b.c-d']) {
      expect(() => assertSafeOwner(ok)).not.toThrow();
    }
  });

  it('weigert traversal- en niet-grammatica-namen', () => {
    for (const bad of ['../evil', 'a/b', '.hidden', '', '..', 'a b']) {
      expect(() => assertSafeOwner(bad)).toThrow(/unsafe owner name/);
    }
  });

  it('vuurt vóór alle I/O op beide publieke entry points', async () => {
    await expect(syncContainerRelays('../evil', 'x')).rejects.toThrow(/unsafe owner name/);
    await expect(ensurePortForwarder('../evil')).rejects.toThrow(/unsafe owner name/);
  });
});
