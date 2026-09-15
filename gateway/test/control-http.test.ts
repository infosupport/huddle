import { describe, it, expect } from 'vitest';
import { feedVersion, isControlPath, presentedVersion } from '../src/control/http';

// ── The control channel's authentication boundary ───────────────────────────
//
// isControlPath decides whether a request is checked against the gateway token
// or waved through as a static asset, so these are not cosmetic string tests.
// No DB, no native binding — they run everywhere, which is the point: the check
// that guards the control channel should not be verifiable only in CI.

describe('isControlPath', () => {
  it('claims the control channel and everything under it', () => {
    expect(isControlPath('/control')).toBe(true);
    expect(isControlPath('/control/health')).toBe(true);
    expect(isControlPath('/control/policy')).toBe(true);
    expect(isControlPath('/control/anything/deeper')).toBe(true);
  });

  it('does not claim a path that merely starts with the same letters', () => {
    // A plain startsWith('/control') would swallow these. Harmless here (they
    // would just demand a token), but it is the same reasoning error that in
    // the other direction publishes the channel.
    expect(isControlPath('/controlpanel')).toBe(false);
    expect(isControlPath('/controls')).toBe(false);
  });

  it('does not claim unrelated routes', () => {
    expect(isControlPath('/')).toBe(false);
    expect(isControlPath('/api/rules')).toBe(false);
    expect(isControlPath('/index.html')).toBe(false);
  });

  it('does not fall for a path that only contains /control/ later on', () => {
    // api.ts strips the query string before asking, so what arrives here is a
    // path — but a route that embeds the string must not be mistaken for one.
    expect(isControlPath('/api/control/policy')).toBe(false);
    expect(isControlPath('/static/control/x')).toBe(false);
  });
});

describe('presentedVersion', () => {
  const V = 'a'.repeat(32);

  it('accepts a bare, a quoted and a weak ETag alike', () => {
    expect(presentedVersion(V)).toBe(V);
    expect(presentedVersion(`"${V}"`)).toBe(V);
    expect(presentedVersion(`W/"${V}"`)).toBe(V);
  });

  it('takes the first value when a client sends several', () => {
    expect(presentedVersion([`"${V}"`, '"other"'])).toBe(V);
  });

  it('is empty when nothing is presented, so a first poll never 304s', () => {
    expect(presentedVersion(undefined)).toBe('');
    expect(presentedVersion('   ')).toBe('');
  });
});

describe('feedVersion', () => {
  it('is stable for the same body', () => {
    expect(feedVersion('{"a":1}')).toBe(feedVersion('{"a":1}'));
  });

  it('changes for any change in the body', () => {
    expect(feedVersion('{"a":1}')).not.toBe(feedVersion('{"a":2}'));
    // Byte-level: a reordering the gateway would deserialize differently must
    // not be reported as unchanged.
    expect(feedVersion('{"a":1,"b":2}')).not.toBe(feedVersion('{"b":2,"a":1}'));
  });

  it('is a fixed-width hex identifier', () => {
    expect(feedVersion('anything')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('never collides with the empty-string version by accident', () => {
    expect(feedVersion('')).not.toBe('');
  });
});
