import { describe, it, expect, vi } from 'vitest';

// socket-proxy imports db.ts only for the grant checks; mocking it keeps the
// native better-sqlite3 binding out of this test (it is absent in a fresh
// DMZ devcontainer, see rules.test.ts / grants.test.ts). ownershipFromInspect
// is pure and never touches the db.
vi.mock('../src/db', () => ({
  getGrant: () => null,
  isHostPortApproved: () => false,
}));

const { ownershipFromInspect } = await import('../src/socket-proxy');

// ── Container-ownership classification (issue #61) ───────────────────────────
// The inspect policy classifies a container as 'own', 'foreign' or 'missing'.
// Only 'own' is passed through to Docker; 'foreign' and 'missing' both get a
// synthesized 404 (see the inspect branch in socket-proxy.ts). That 'foreign'
// also yields a 404 is deliberate: it makes a foreign container
// indistinguishable from a nonexistent one (no existence oracle), and Aspire's
// DCP sees a not-yet-created persistent container as absent → creates it. The
// distinction 'foreign' vs 'missing' is kept so a probe against a genuinely
// existing foreign container can be logged as suspicious. This pure function
// is the decision point.
describe('ownershipFromInspect', () => {
  const own = { Config: { Labels: { 'huddle.parent': 'dc-a' } } };

  it('classifies our own container as "own"', () => {
    expect(ownershipFromInspect(200, own, 'dc-a')).toBe('own');
  });

  it('classifies a container of another devcontainer as "foreign"', () => {
    expect(ownershipFromInspect(200, own, 'dc-b')).toBe('foreign');
  });

  it('classifies an unlabeled container as "foreign"', () => {
    expect(ownershipFromInspect(200, { Config: { Labels: {} } }, 'dc-a')).toBe('foreign');
    expect(ownershipFromInspect(200, { Config: {} }, 'dc-a')).toBe('foreign');
  });

  it('classifies a 404 (No such container) as "missing"', () => {
    // THIS is the core of issue #61: a nonexistent container must not yield a
    // 403 "not owned" but be passed through as "missing", so Docker returns
    // its own 404 and DCP still creates the persistent container.
    expect(ownershipFromInspect(404, { message: 'No such container: sqlserver-x' }, 'dc-a')).toBe('missing');
  });

  it('safely treats an unexpected error (5xx) as "foreign", not "missing"', () => {
    expect(ownershipFromInspect(500, { message: 'boom' }, 'dc-a')).toBe('foreign');
    expect(ownershipFromInspect(500, null, 'dc-a')).toBe('foreign');
  });

  it('safely treats an unreadable/empty body on a 200 as "foreign"', () => {
    expect(ownershipFromInspect(200, null, 'dc-a')).toBe('foreign');
  });
});
