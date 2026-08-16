// ── Rule projection (pure) ────────────────────────────────────────────────────
// The pure heart of the one-way Huddle → sbx sync: given Huddle's rule rows,
// compute the DESIRED sbx policy set, plus the rules we deliberately could not
// project. No DB, no host-agent, no IO — so it is trivially testable and the
// honest limits (ADR §4) live in one place. reconcile.ts wraps this with IO.

import { isValidPolicyTarget, isValidSandboxName, type Scope, type PolicyRule } from './protocol';

export interface HuddleRuleRow {
  domain: string;
  container_id: string | null;
  status: 'allow' | 'deny' | 'requested';
  path_pattern: string | null;
  path_mode: number;
  expires_at: number | null;
}

export interface SkippedRule {
  domain: string;
  container_id: string | null;
  reason: string;
}

export function scopeKey(scope: Scope): string {
  return scope.kind === 'sandbox' ? `sbx:${scope.name}` : 'global';
}

export function ruleKey(action: string, target: string, scope: Scope): string {
  return `${scopeKey(scope)}|${action}|${target.toLowerCase()}`;
}

/**
 * Project Huddle's rules into the sbx policy shape. Returns the desired policy
 * set plus the rules we deliberately could not project (path rules) or skipped.
 *
 * Honest limits enforced here (ADR §4):
 *   • sbx policy is DOMAIN-LEVEL ONLY — path-mode / path-pattern rules are NOT
 *     projected; they are reported as `notProjected` (enforced fleet-wide at
 *     Huddle's proxy, never per-sandbox in sbx mode).
 *   • `requested` (unapproved) and expired rules are skipped.
 *   • an invalid sandbox name or policy target is skipped rather than mis-scoped.
 */
export function projectRules(
  rows: HuddleRuleRow[],
  nowSec: number,
  sandboxNames: Set<string>
): { desired: Map<string, PolicyRule>; notProjected: SkippedRule[]; skipped: SkippedRule[] } {
  const desired = new Map<string, PolicyRule>();
  const notProjected: SkippedRule[] = [];
  const skipped: SkippedRule[] = [];

  for (const r of rows) {
    if (r.status === 'requested') {
      skipped.push({ domain: r.domain, container_id: r.container_id, reason: 'requested (not yet approved)' });
      continue;
    }
    if (r.expires_at != null && r.expires_at <= nowSec) {
      skipped.push({ domain: r.domain, container_id: r.container_id, reason: 'expired' });
      continue;
    }
    // Path-mode / path-pattern rules cannot be expressed by sbx policy (domain-only).
    if (r.path_mode !== 0 || (r.path_pattern != null && r.path_pattern !== '')) {
      notProjected.push({
        domain: r.domain,
        container_id: r.container_id,
        reason: 'path rule — not expressible in sbx policy; enforced fleet-wide at Huddle proxy',
      });
      continue;
    }
    if (!isValidPolicyTarget(r.domain)) {
      skipped.push({ domain: r.domain, container_id: r.container_id, reason: 'target not a valid sbx policy target' });
      continue;
    }
    // Skip Huddle's own self-rule — it is proxy plumbing, not sandbox egress.
    if (r.domain.toLowerCase() === 'huddle') {
      skipped.push({ domain: r.domain, container_id: r.container_id, reason: 'internal huddle rule' });
      continue;
    }

    // Project GLOBAL rules → sbx global policy, and each SANDBOX's own rules →
    // that sandbox's sbx policy (sbx enforces per-box). Per-real-container rules
    // are container-mode (enforced at Huddle's proxy) and are NOT projected — we
    // tell sandboxes apart from containers via the known-sandbox set.
    const isGlobal = r.container_id == null || r.container_id === '';
    let scope: Scope;
    if (isGlobal) {
      scope = { kind: 'global' };
    } else if (isValidSandboxName(r.container_id) && sandboxNames.has(r.container_id as string)) {
      scope = { kind: 'sandbox', name: r.container_id as string };
    } else {
      skipped.push({ domain: r.domain, container_id: r.container_id, reason: 'per-container rule (not a known sandbox) — enforced at Huddle proxy, not projected to sbx' });
      continue;
    }

    const action = r.status; // 'allow' | 'deny'
    desired.set(ruleKey(action, r.domain, scope), { action, target: r.domain, scope });
  }

  return { desired, notProjected, skipped };
}
