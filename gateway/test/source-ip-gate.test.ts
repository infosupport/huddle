import { describe, it, expect } from 'vitest';
import { ipv4ToInt, cidrToRange, isDevcontainerSource, type IpRange } from '../src/net-gate';

// ── Boundary C — management-API source-IP gate ──────────────────────────────
// Containers op devcontainer-net / dc-net-* mogen de management-API NIET bereiken
// (alleen de sudo-audit whitelist). De gate beslist op basis van het bron-IP.

describe('ipv4ToInt', () => {
  it('converteert een geldig IPv4-adres', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xFFFFFFFF);
    expect(ipv4ToInt('172.18.0.1')).toBe(((172 << 24) | (18 << 16) | 1) >>> 0);
  });

  it('geeft -1 voor ongeldige input', () => {
    expect(ipv4ToInt('not.an.ip')).toBe(-1);
    expect(ipv4ToInt('1.2.3')).toBe(-1);
    expect(ipv4ToInt('256.0.0.1')).toBe(-1);
    expect(ipv4ToInt('1.2.3.4.5')).toBe(-1);
  });
});

describe('cidrToRange', () => {
  it('normaliseert de base tegen het masker', () => {
    const r = cidrToRange('172.18.5.9/16');
    expect(r).not.toBeNull();
    const [base, mask] = r as IpRange;
    expect(mask).toBe(0xFFFF0000);
    expect(base).toBe(ipv4ToInt('172.18.0.0')); // host-bits weggemaskeerd
  });

  it('weigert niet-IPv4 / ongeldige CIDR (geen IPv6, geen rommel)', () => {
    expect(cidrToRange('fd00::/8')).toBeNull();
    expect(cidrToRange('')).toBeNull();
    expect(cidrToRange('999.1.1.1/16')).toBeNull();
    expect(cidrToRange('10.0.0.0/33')).toBeNull();
  });
});

describe('isDevcontainerSource', () => {
  const subnets: IpRange[] = [
    cidrToRange('172.18.0.0/16')!, // devcontainer-net
    cidrToRange('172.20.0.0/24')!, // een dc-net-*
  ];

  it('herkent een IP binnen een geblokkeerd subnet', () => {
    expect(isDevcontainerSource('172.18.42.7', subnets)).toBe(true);
    expect(isDevcontainerSource('172.20.0.5', subnets)).toBe(true);
  });

  it('pelt de IPv4-mapped IPv6-prefix af', () => {
    expect(isDevcontainerSource('::ffff:172.18.0.9', subnets)).toBe(true);
  });

  it('staat een IPv4 buiten elk subnet toe (= geen devcontainer-bron, bv. docker-gateway)', () => {
    expect(isDevcontainerSource('10.0.0.1', subnets)).toBe(false);
    expect(isDevcontainerSource('172.20.1.5', subnets)).toBe(false); // /24 → buiten bereik
    expect(isDevcontainerSource('172.17.0.1', subnets)).toBe(false); // bridge-gateway (admin via -p)
  });

  it('staat loopback toe (huddle-host zelf / port-forward)', () => {
    expect(isDevcontainerSource('127.0.0.1', subnets)).toBe(false);
    expect(isDevcontainerSource('::1', subnets)).toBe(false);
  });

  it('is fail-closed: raw IPv6 wordt als devcontainer behandeld (IPv6-bypass gedicht)', () => {
    expect(isDevcontainerSource('fd00::5', subnets)).toBe(true);
    expect(isDevcontainerSource('2001:db8::1', subnets)).toBe(true);
  });

  it('is fail-closed op ontbrekend/ongeldig adres', () => {
    expect(isDevcontainerSource(undefined, subnets)).toBe(true);
    expect(isDevcontainerSource(null, subnets)).toBe(true);
    expect(isDevcontainerSource('garbage', subnets)).toBe(true);
  });
});
