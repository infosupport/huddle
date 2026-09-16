import { describe, it, expect, vi } from 'vitest';

// ── dc-net gateway: the host end of the bridge ───────────────────────────────
// The devcontainer's egress firewall exempts its whole dc-net subnet so that
// compose siblings (postgres on :5432, ...) are reachable. The gateway address
// sits in that same subnet but belongs to the HOST: without an explicit
// exclusion the exemption also opens every service on the developer's machine
// that listens on 0.0.0.0, past the proxy and its audit trail.
//
// ipv4Gateways is what feeds that exclusion, and the generated script drops the
// subnet exemption entirely when the list comes back empty (fail closed). Both
// halves matter here: a gateway that is missed stays exposed, and a value that
// is not a bare dotted quad ends up inside a shell script.
//
// docker.ts imports db.ts for settings/folder mappings; mocking keeps the native
// better-sqlite3 binding out of this test (see socket-proxy.test.ts).
vi.mock('../src/db', () => ({
  getSetting: () => null,
  listFolderMappings: () => [],
}));

import { ipv4Gateways } from '../src/docker';

describe('ipv4Gateways', () => {
  it('reads the gateway from the network IPAM config', () => {
    expect(ipv4Gateways({ IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] } }))
      .toEqual(['172.20.0.1']);
  });

  it('returns every configured gateway', () => {
    expect(ipv4Gateways({ IPAM: { Config: [{ Gateway: '172.20.0.1' }, { Gateway: '10.5.0.1' }] } }))
      .toEqual(['172.20.0.1', '10.5.0.1']);
  });

  // This is the shape huddle's own `internal` dc-net produces on the container
  // side, which is exactly why the value is read from the network instead.
  it('ignores an entry without a gateway', () => {
    expect(ipv4Gateways({ IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '' }] } })).toEqual([]);
  });

  it('ignores IPv6 gateways — the exclusion is an iptables (v4) rule', () => {
    expect(ipv4Gateways({ IPAM: { Config: [{ Gateway: 'fd00::1' }] } })).toEqual([]);
  });

  // The value is interpolated into the firewall shell script, so anything that
  // is not a bare dotted quad is dropped rather than passed through.
  it.each(['172.20.0.1; rm -rf /', '$(id)', '172.20.0.1/16', '172.20.0.1 10.0.0.1', '`id`'])(
    'drops %j instead of interpolating it', (gw) => {
      expect(ipv4Gateways({ IPAM: { Config: [{ Gateway: gw }] } })).toEqual([]);
    });

  it('survives a missing or malformed inspect result', () => {
    for (const network of [undefined, null, {}, { IPAM: {} }, { IPAM: { Config: 'nope' } }, { IPAM: { Config: [null] } }]) {
      expect(ipv4Gateways(network)).toEqual([]);
    }
  });
});
