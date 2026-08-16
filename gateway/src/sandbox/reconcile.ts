// ── Rule reconciliation (Huddle → sbx policy), one-way ────────────────────────
// Huddle's SQLite `rules` table is the SINGLE SOURCE OF TRUTH. In sbx mode we
// PROJECT that ruleset into sbx's own policy engine and let sbx enforce
// per-sandbox. The sync is strictly one-way and reconciled on drift:
//
//   • a rule in Huddle but missing in sbx → CREATE it in sbx
//   • a rule in sbx but not in Huddle     → DELETE it from sbx (drift)
//
// See docs/ADR-workspace-runtime-abstraction.md §4. Honest limits enforced here:
//   • sbx policy is DOMAIN-LEVEL ONLY (no path patterns). Path-mode rules are
//     therefore NOT projected — they are reported as `notProjected` so the UI can
//     surface them honestly as "enforced fleet-wide at Huddle's proxy, not sbx".
//   • per the ADR, path rules are only meaningful GLOBALLY in sbx mode; we never
//     invent per-sandbox path attribution that sbx cannot express.

import { db } from '../db';
import * as ops from './ops';
import { type Scope, type PolicyRule } from './protocol';
import { projectRules, scopeKey, ruleKey, type HuddleRuleRow, type SkippedRule } from './projection';
import { setKnownSandboxes } from './registry';

export type { HuddleRuleRow, SkippedRule } from './projection';
export { projectRules } from './projection';

export interface ReconcileAction {
  op: 'create' | 'delete';
  action: 'allow' | 'deny';
  target: string;
  scope: Scope;
  ok: boolean;
  error?: string;
}

export interface ReconcileReport {
  ok: boolean;
  dryRun: boolean;
  desired: number;
  created: number;
  deleted: number;
  failed: number;
  actions: ReconcileAction[];
  /** Path-mode rules that sbx cannot express — enforced at Huddle's proxy instead. */
  notProjected: SkippedRule[];
  /** Rules skipped for another reason (invalid target/name, expired, requested). */
  skipped: SkippedRule[];
  sandboxes: string[];
  error?: string;
}

/** Read every enforceable rule straight from the source of truth. */
function readHuddleRules(): HuddleRuleRow[] {
  // Defensive column list — path_pattern/path_mode/expires_at are migration-added.
  const rows = db
    .prepare(
      `SELECT domain,
              container_id,
              status,
              COALESCE(path_pattern, NULL) AS path_pattern,
              COALESCE(path_mode, 0)       AS path_mode,
              COALESCE(expires_at, NULL)   AS expires_at
         FROM rules`
    )
    .all() as HuddleRuleRow[];
  return rows;
}

/**
 * Compute and (unless dryRun) apply the one-way projection. Never throws for an
 * enforcement gap — everything is captured in the report so the UI/CLI can be
 * honest about what synced and what could not.
 */
export async function reconcile(opts: { dryRun?: boolean } = {}): Promise<ReconcileReport> {
  const dryRun = !!opts.dryRun;
  const nowSec = Math.floor(Date.now() / 1000);
  const report: ReconcileReport = {
    ok: false,
    dryRun,
    desired: 0,
    created: 0,
    deleted: 0,
    failed: 0,
    actions: [],
    notProjected: [],
    skipped: [],
    sandboxes: [],
  };

  // Verify sbx is reachable (through the mailbox) before we do anything mutating.
  try {
    await ops.version();
  } catch (err) {
    report.error = (err as Error).message;
    return report;
  }

  // Which sandboxes exist? Global rules → sbx global; each sandbox's own rules →
  // that sandbox's sbx policy. We reconcile the global scope + every live sandbox.
  const sandboxNames = new Set<string>();
  try {
    for (const s of await ops.list()) sandboxNames.add(s.name);
  } catch {
    /* sbx ls may fail — reconcile global only */
  }
  setKnownSandboxes(sandboxNames);

  const { desired, notProjected, skipped } = projectRules(readHuddleRules(), nowSec, sandboxNames);
  report.desired = desired.size;
  report.notProjected = notProjected;
  report.skipped = skipped;

  const scopes: Scope[] = [{ kind: 'global' }, ...[...sandboxNames].map((name) => ({ kind: 'sandbox', name } as Scope))];
  report.sandboxes = [...sandboxNames];

  // Read the actual policy set across all relevant scopes.
  const actual = new Map<string, PolicyRule>();
  for (const scope of scopes) {
    try {
      for (const rule of await ops.policyList({ scope })) {
        // policyList's global read may not carry scope; stamp the scope we queried.
        const stamped: PolicyRule = { ...rule, scope: rule.scope ?? scope };
        actual.set(ruleKey(stamped.action, stamped.target, stamped.scope), stamped);
      }
    } catch (err) {
      report.actions.push({
        op: 'delete',
        action: 'deny',
        target: `(policy list ${scopeKey(scope)})`,
        scope,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  // CREATE: desired \ actual
  for (const [key, rule] of desired) {
    if (actual.has(key)) continue;
    if (dryRun) {
      report.actions.push({ op: 'create', action: rule.action, target: rule.target, scope: rule.scope, ok: true });
      report.created++;
      continue;
    }
    try {
      await ops.policySet({ scope: rule.scope, action: rule.action, target: rule.target });
      report.actions.push({ op: 'create', action: rule.action, target: rule.target, scope: rule.scope, ok: true });
      report.created++;
    } catch (err) {
      report.actions.push({ op: 'create', action: rule.action, target: rule.target, scope: rule.scope, ok: false, error: (err as Error).message });
      report.failed++;
    }
  }

  // DELETE: actual \ desired (drift — sbx has a rule Huddle does not author)
  for (const [key, rule] of actual) {
    if (desired.has(key)) continue;
    if (dryRun) {
      report.actions.push({ op: 'delete', action: rule.action, target: rule.target, scope: rule.scope, ok: true });
      report.deleted++;
      continue;
    }
    try {
      await ops.policyRemove({ scope: rule.scope, target: rule.target });
      report.actions.push({ op: 'delete', action: rule.action, target: rule.target, scope: rule.scope, ok: true });
      report.deleted++;
    } catch (err) {
      report.actions.push({ op: 'delete', action: rule.action, target: rule.target, scope: rule.scope, ok: false, error: (err as Error).message });
      report.failed++;
    }
  }

  report.ok = report.failed === 0;
  return report;
}
