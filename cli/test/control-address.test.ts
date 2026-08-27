import { describe, it, expect } from 'vitest';

import { parseBridgeGateway, resolveControlAddress, HOST_ALIAS } from '../src/control-address';

// Where the gateway looks for Huddle Node. Pure by construction (the engine
// probing lives in bridgeGateway), and worth testing precisely because getting
// it wrong is a security decision, not a connectivity one: the failure modes are
// "binds the control channel on every interface" and "silently unreachable".

describe('parseBridgeGateway', () => {
  it('reads the Docker shape (IPAM.Config[].Gateway)', () => {
    const json = JSON.stringify([{ Name: 'bridge', IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] } }]);
    expect(parseBridgeGateway(json)).toBe('172.17.0.1');
  });

  it('reads the Podman shape (subnets[].gateway)', () => {
    const json = JSON.stringify([{ name: 'podman', subnets: [{ subnet: '10.88.0.0/16', gateway: '10.88.0.1' }] }]);
    expect(parseBridgeGateway(json)).toBe('10.88.0.1');
  });

  it('accepts a bare object as well as the usual array', () => {
    expect(parseBridgeGateway(JSON.stringify({ IPAM: { Config: [{ Gateway: '192.168.5.1' }] } }))).toBe('192.168.5.1');
  });

  it('skips rows without a gateway and takes the first that has one', () => {
    const json = JSON.stringify([{ IPAM: { Config: [{ Subnet: '172.17.0.0/16' }, { Gateway: '172.17.0.1' }] } }]);
    expect(parseBridgeGateway(json)).toBe('172.17.0.1');
  });

  it('returns null for unparseable or empty output', () => {
    expect(parseBridgeGateway('')).toBeNull();
    expect(parseBridgeGateway('not json')).toBeNull();
    expect(parseBridgeGateway('[]')).toBeNull();
    expect(parseBridgeGateway(JSON.stringify([{ IPAM: { Config: [] } }]))).toBeNull();
  });

  it('rejects anything that is not a bare IP literal', () => {
    // This value becomes a bind address and part of a `docker run -e ...`
    // argument, so a hostname, a CIDR suffix or a shell metacharacter is
    // refused rather than passed on.
    for (const bad of ['gateway.local', '172.17.0.1/16', '172.17.0.1; rm -rf /', '999.1.1.1', '$(whoami)', ' ']) {
      expect(parseBridgeGateway(JSON.stringify([{ IPAM: { Config: [{ Gateway: bad }] } }]))).toBeNull();
    }
  });

  it('accepts an IPv6 gateway', () => {
    expect(parseBridgeGateway(JSON.stringify([{ subnets: [{ gateway: 'fd00::1' }] }]))).toBe('fd00::1');
  });
});

describe('resolveControlAddress', () => {
  const PORT = 24843;

  it('engine in a VM: host alias, Node stays on loopback', () => {
    const a = resolveControlAddress({ isRemote: true, port: PORT, gatewayIp: null });
    expect(a.bindHost).toBe('127.0.0.1');
    expect(a.url).toBe(`http://${HOST_ALIAS}:${PORT}`);
    expect(a.runArgs).toEqual(['--add-host', `${HOST_ALIAS}:host-gateway`]);
    expect(a.reachable).toBe(true);
  });

  it('native engine: binds the bridge address, not every interface', () => {
    const a = resolveControlAddress({ isRemote: false, port: PORT, gatewayIp: '172.17.0.1' });
    expect(a.bindHost).toBe('172.17.0.1');
    expect(a.url).toBe(`http://172.17.0.1:${PORT}`);
    // No host alias needed — the container reaches the address directly.
    expect(a.runArgs).toEqual([]);
    expect(a.reachable).toBe(true);
  });

  it('native engine with no readable bridge address: loopback and honestly unreachable', () => {
    // 0.0.0.0 would put the control channel on the LAN and any VPN to fix a
    // problem nobody has confirmed. A visibly dead firewall beats a quietly
    // widened one, so init warns instead.
    const a = resolveControlAddress({ isRemote: false, port: PORT, gatewayIp: null });
    expect(a.bindHost).toBe('127.0.0.1');
    expect(a.reachable).toBe(false);
    expect(a.reason).toMatch(/could not be read/);
  });

  it('an explicit URL wins, and drops the host alias nobody asked for', () => {
    const a = resolveControlAddress({
      isRemote: false, port: PORT, gatewayIp: null, override: 'http://10.0.0.9:24843',
    });
    expect(a.url).toBe('http://10.0.0.9:24843');
    expect(a.runArgs).toEqual([]);
    expect(a.reachable).toBe(true);
    expect(a.reason).toMatch(/explicitly/);
  });

  it('an explicit bind host wins on the bind side only', () => {
    const a = resolveControlAddress({
      isRemote: true, port: PORT, gatewayIp: null, bindOverride: '192.168.1.5',
    });
    expect(a.bindHost).toBe('192.168.1.5');
    expect(a.url).toBe(`http://${HOST_ALIAS}:${PORT}`);
    expect(a.reachable).toBe(true);
  });

  it('trims the overrides and ignores blank ones', () => {
    const a = resolveControlAddress({
      isRemote: false, port: PORT, gatewayIp: '172.17.0.1', override: '   ', bindOverride: '',
    });
    expect(a.bindHost).toBe('172.17.0.1');
    expect(a.url).toBe(`http://172.17.0.1:${PORT}`);
    expect(a.reason).toMatch(/native engine/);
  });
});
