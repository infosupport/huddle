import { describe, it, expect } from 'vitest';
import { projectRules, type HuddleRuleRow } from '../src/sandbox/projection';

// projectRules projects Huddle rules into sbx policy: GLOBAL rules → sbx global;
// a KNOWN sandbox's own rules → that sandbox's sbx scope; per-real-container
// rules (not a known sandbox) are NOT projected; path rules can't be.
const NOW = 1_800_000_000;
const SANDBOXES = new Set(['box1', 'box2']);

function row(p: Partial<HuddleRuleRow>): HuddleRuleRow {
  return { domain: 'example.com', container_id: null, status: 'allow', path_pattern: null, path_mode: 0, expires_at: null, ...p };
}

describe('projectRules', () => {
  it('projects a global rule to sbx global scope', () => {
    const { desired } = projectRules([row({ domain: 'api.example.com' })], NOW, SANDBOXES);
    expect([...desired.values()][0]).toEqual({ action: 'allow', target: 'api.example.com', scope: { kind: 'global' } });
  });

  it("projects a known sandbox's rule to that sandbox's scope", () => {
    const { desired } = projectRules([row({ domain: 'api.test', container_id: 'box1', status: 'deny' })], NOW, SANDBOXES);
    expect([...desired.values()][0]).toEqual({ action: 'deny', target: 'api.test', scope: { kind: 'sandbox', name: 'box1' } });
  });

  it('keeps global and per-sandbox rules for the same domain distinct', () => {
    const { desired } = projectRules([row({ domain: 'x.io' }), row({ domain: 'x.io', container_id: 'box1' })], NOW, SANDBOXES);
    expect(desired.size).toBe(2);
  });

  it('does NOT project a per-container rule that is not a known sandbox', () => {
    const { desired, skipped } = projectRules([row({ domain: 'x.io', container_id: 'devcontainer-foo' })], NOW, SANDBOXES);
    expect(desired.size).toBe(0);
    expect(skipped[0].reason).toMatch(/not a known sandbox/);
  });

  it('path-mode rule → domain allowed FLEET-WIDE (sbx global); paths noted as Huddle-enforced', () => {
    const { desired, notProjected } = projectRules([row({ domain: 'files.io', container_id: 'box1', path_mode: 1 })], NOW, SANDBOXES);
    expect([...desired.values()]).toContainEqual({ action: 'allow', target: 'files.io', scope: { kind: 'global' } });
    expect(notProjected[0].reason).toMatch(/path rule/i);
  });

  it('multiple path rules for one domain → a single global allow', () => {
    const { desired } = projectRules([
      row({ domain: 'files.io', path_mode: 1 }),
      row({ domain: 'files.io', path_pattern: '/a/*' }),
      row({ domain: 'files.io', path_pattern: '/b/*' }),
    ], NOW, SANDBOXES);
    expect([...desired.values()].filter((r) => r.target === 'files.io')).toEqual([{ action: 'allow', target: 'files.io', scope: { kind: 'global' } }]);
  });

  it('skips requested / expired / invalid-target / internal-huddle rules', () => {
    const { desired, skipped } = projectRules([
      row({ status: 'requested', container_id: 'box1' }),
      row({ domain: 'gone.io', container_id: 'box1', expires_at: NOW - 1 }),
      row({ domain: 'has space.io', container_id: 'box1' }),
      row({ domain: 'huddle', container_id: 'box1' }),
    ], NOW, SANDBOXES);
    expect(desired.size).toBe(0);
    expect(skipped.length).toBe(4);
  });
});
