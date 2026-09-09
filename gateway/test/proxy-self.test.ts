import { describe, it, expect } from 'vitest';
import { canonicalizeHost } from '../src/rule-match';
import { isPublicSelfEndpoint, isSelfHost } from '../src/proxy-self';

// ── Traffic a devcontainer addresses to Huddle itself ───────────────────────
//
// The proxy resolves these in ITS namespace, not the caller's, so they reach
// Huddle's own API and proxy ports. Refused regardless of policy — which is why
// this is worth testing without a database: it is the check that stands when
// default-deny has been overridden.

describe('isSelfHost', () => {
  it('recognises the name devcontainers reach the proxy by', () => {
    expect(isSelfHost('huddle')).toBe(true);
  });

  it('recognises loopback in the spellings a URL can carry', () => {
    for (const h of ['localhost', 'ip6-localhost', 'ip6-loopback', '[::1]']) {
      expect(isSelfHost(h)).toBe(true);
    }
  });

  it('recognises IPv4-mapped loopback, which canonicalizes to hex', () => {
    expect(isSelfHost('[::ffff:7f00:1]')).toBe(true);
    expect(isSelfHost('[::ffff:7f00:2]')).toBe(true);
    expect(isSelfHost('[::ffff:7fff:fffe]')).toBe(true);
    // Not the mapped block: ::ffff:128.0.0.1
    expect(isSelfHost('[::ffff:8000:1]')).toBe(false);
  });

  it('recognises the whole 127.0.0.0/8 block, not just 127.0.0.1', () => {
    // 127.0.0.1 is the obvious one; the rest of the block reaches the same
    // interface and would otherwise walk straight past the check.
    expect(isSelfHost('127.0.0.1')).toBe(true);
    expect(isSelfHost('127.0.0.2')).toBe(true);
    expect(isSelfHost('127.1.2.3')).toBe(true);
    expect(isSelfHost('127.255.255.254')).toBe(true);
  });

  it('recognises the unspecified address, which also lands on this host', () => {
    expect(isSelfHost('0.0.0.0')).toBe(true);
    expect(isSelfHost('[::]')).toBe(true);
  });

  it('leaves ordinary destinations alone', () => {
    for (const h of ['example.com', 'registry.npmjs.org', '10.0.0.1', '172.17.0.5', '128.0.0.1']) {
      expect(isSelfHost(h)).toBe(false);
    }
  });

  it('is not fooled by a host that merely contains a self name', () => {
    expect(isSelfHost('huddle.example.com')).toBe(false);
    expect(isSelfHost('notlocalhost')).toBe(false);
    expect(isSelfHost('localhost.evil.test')).toBe(false);
    // 127.0.0.1.nip.io resolves to loopback for the CALLER, but as a hostname it
    // is a normal domain here and the rule engine decides it.
    expect(isSelfHost('127.0.0.1.nip.io')).toBe(false);
  });

  it('expects an already-canonicalized host', () => {
    // canonicalizeHost lowercases at the proxy boundary; comparing anything
    // else is the parser-differential bug from finding #3. Documented by test
    // so nobody "fixes" the missing toLowerCase() here instead of upstream.
    expect(isSelfHost('LOCALHOST')).toBe(false);
    // Bare IPv6 likewise: canonicalizeHost REJECTS it (null -> 400), so the
    // proxy never asks about this form.
    expect(canonicalizeHost('::1')).toBe(null);
    expect(isSelfHost('::1')).toBe(false);
  });

  // The predicate is only as good as the canonicalization in front of it, so
  // check the pair end-to-end rather than trusting an assumption about the
  // parser. These are the spellings an SSRF filter classically misses.
  it('catches the obfuscated loopback spellings once canonicalized', () => {
    for (const raw of [
      '127.0.0.1', '127.1', '127.000.000.001', '2130706433', '0x7f000001',
      'LocalHost', 'localhost.', '[0:0:0:0:0:0:0:1]', '[0::1]',
      '[::ffff:127.0.0.1]', 'HUDDLE', 'huddle.',
    ]) {
      const canonical = canonicalizeHost(raw);
      expect(canonical, raw).not.toBe(null);
      expect(isSelfHost(canonical!), `${raw} -> ${canonical}`).toBe(true);
    }
  });
});

describe('isPublicSelfEndpoint', () => {
  const ok = (port: string, method: string, path: string) =>
    isPublicSelfEndpoint(port, method, path, 3000);

  it('admits the sudo-audit ingest devcontainers depend on', () => {
    expect(ok('3000', 'POST', '/api/audit/sudo')).toBe(true);
  });

  it('follows the configured API port rather than a hardcoded 3000', () => {
    expect(isPublicSelfEndpoint('24842', 'POST', '/api/audit/sudo', 24842)).toBe(true);
    expect(isPublicSelfEndpoint('3000', 'POST', '/api/audit/sudo', 24842)).toBe(false);
  });

  it('admits nothing else on the API port', () => {
    expect(ok('3000', 'GET', '/api/rules')).toBe(false);
    expect(ok('3000', 'POST', '/api/rules')).toBe(false);
    expect(ok('3000', 'GET', '/api/audit/sudo')).toBe(false);
    expect(ok('3000', 'POST', '/api/audit/sudo/../rules')).toBe(false);
  });

  it('does not admit the right path on the wrong port', () => {
    // Port 80 is the proxy's own listener: forwarding there loops it back.
    expect(ok('', 'POST', '/api/audit/sudo')).toBe(false);
    expect(ok('80', 'POST', '/api/audit/sudo')).toBe(false);
    expect(ok('32768', 'POST', '/api/audit/sudo')).toBe(false);
  });

  it('requires an exact path — no prefix, no query left on it', () => {
    expect(ok('3000', 'POST', '/api/audit/sudox')).toBe(false);
    expect(ok('3000', 'POST', '/api/audit/sudo/')).toBe(false);
    expect(ok('3000', 'POST', null)).toBe(false);
  });
});
