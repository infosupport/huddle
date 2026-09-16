import { describe, it, expect, vi } from 'vitest';

// ── Docker socket proxy: network policy (relay prevention) ───────────────────
// The devcontainer's egress firewall ACCEPTs its entire dc-net subnet so that
// compose siblings are reachable (postgres on :5432 and friends). That exemption
// is only safe while every sibling is a dead end. A sibling that is attached to a
// second, routable network is a relay: the devcontainer reaches it over the
// exempted subnet and it forwards anywhere the proxy would have blocked.
//
// Three rules keep siblings single-homed, and this suite covers the two pure
// ones (the third — forced NetworkMode on container-create — lives in the
// connection handler):
//   1. network.create is rewritten to an internal bridge network.
//   2. network.connect/disconnect only accept an owned, internal network.
//
// socket-proxy imports db.ts only for the grant checks; mocking keeps the native
// better-sqlite3 binding out of this test (see socket-proxy.test.ts).
vi.mock('../src/db', () => ({
  getGrant: () => null,
  getActionPolicy: () => null,
  isHostPortApproved: () => false,
}));

import { networkAttachDenial, sanitizeNetworkCreate } from '../src/socket-proxy';

const DC = 'dc-a';

describe('networkAttachDenial', () => {
  it('allows the devcontainer its own dc-net', () => {
    expect(networkAttachDenial(DC, { parent: null, name: 'dc-net-dc-a', internal: true })).toBeNull();
  });

  it('allows a network the devcontainer created itself', () => {
    expect(networkAttachDenial(DC, { parent: DC, name: 'proj_default', internal: true })).toBeNull();
  });

  it('denies the default bridge — a sibling there is a route around the proxy', () => {
    expect(networkAttachDenial(DC, { parent: null, name: 'bridge', internal: false }))
      .toMatch(/not owned/);
  });

  it('denies another devcontainer\'s dc-net', () => {
    expect(networkAttachDenial(DC, { parent: null, name: 'dc-net-dc-b', internal: true }))
      .toMatch(/not owned/);
  });

  it('denies a network owned by another devcontainer', () => {
    expect(networkAttachDenial(DC, { parent: 'dc-b', name: 'proj_default', internal: true }))
      .toMatch(/not owned/);
  });

  // Networks created before the forced Internal above are owned but routable;
  // ownership alone is therefore not enough.
  it('denies an owned but non-internal network', () => {
    expect(networkAttachDenial(DC, { parent: DC, name: 'legacy_default', internal: false }))
      .toMatch(/non-internal/);
  });

  // Fail-closed: a failed network inspect arrives as name '' / internal false.
  it('denies when the network could not be inspected', () => {
    expect(networkAttachDenial(DC, { parent: null, name: '', internal: false })).not.toBeNull();
  });
});

describe('sanitizeNetworkCreate', () => {
  it('forces Internal and stamps ownership', () => {
    const body: any = { Name: 'proj_default', Driver: 'bridge' };
    expect(sanitizeNetworkCreate(body, DC)).toBeNull();
    expect(body.Internal).toBe(true);
    expect(body.Labels['huddle.parent']).toBe(DC);
    expect(body.Options['com.docker.network.driver.mtu']).toBe('1400');
  });

  it('overrides a client-supplied Internal: false', () => {
    const body: any = { Name: 'escape', Internal: false };
    expect(sanitizeNetworkCreate(body, DC)).toBeNull();
    expect(body.Internal).toBe(true);
  });

  // Parser-differential: the daemon matches struct fields case-insensitively, so
  // a lowercase `internal` would otherwise survive next to our forced key.
  it('canonicalizes a lowercase internal key instead of leaving it beside ours', () => {
    const body: any = { Name: 'escape', internal: false };
    expect(sanitizeNetworkCreate(body, DC)).toBeNull();
    expect(Object.keys(body).filter(k => k.toLowerCase() === 'internal')).toEqual(['Internal']);
    expect(body.Internal).toBe(true);
  });

  it('denies case-insensitive duplicate keys', () => {
    expect(sanitizeNetworkCreate({ Name: 'x', Internal: false, internal: false }, DC))
      .toMatch(/ambiguous/);
  });

  it.each(['macvlan', 'ipvlan', 'host', 'overlay', 'MACVLAN'])(
    'denies the %s driver, which Internal cannot contain', (driver) => {
      expect(sanitizeNetworkCreate({ Name: 'x', Driver: driver }, DC))
        .toMatch(/driver not permitted/);
    }
  );

  it('accepts an omitted driver (daemon default is bridge)', () => {
    expect(sanitizeNetworkCreate({ Name: 'x' }, DC)).toBeNull();
  });

  it('does not let a spoofed label forge ownership', () => {
    const body: any = { Name: 'x', Labels: { 'huddle.parent': 'dc-b' } };
    expect(sanitizeNetworkCreate(body, DC)).toBeNull();
    expect(body.Labels['huddle.parent']).toBe(DC);
  });
});
