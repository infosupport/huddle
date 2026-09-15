// ── sbx policy reconciliation: one allow-all rule per Huddle sandbox ──────────
// Huddle-managed sandboxes are ALLOW-ALL in sbx and every egress decision is
// taken at Huddle's proxy, which can now attribute a request to one box by the
// credential its upstream-proxy URL carries (docs/ADR-sbx-identity.md §6).
//
// This file used to mirror Huddle's whole ruleset into sbx' own policy engine.
// That existed because the proxy could not tell boxes apart, and it cost path
// rules entirely — sbx policy is domain-level, so a path rule could only ever be
// enforced fleet-wide or not at all. With identity in place the second engine
// buys nothing, so sbx gets out of the way and Huddle becomes the single
// enforcement point, with one audit trail and one place to approve a domain.
//
// Per Huddle-managed sandbox, reconciliation now keeps exactly one rule —
// `allow *` — and clears what the old projection left behind:
//
//   • no allow-all rule             → CREATE it
//   • more than one allow-all rule  → DELETE the extras
//   • a target Huddle projected here → DELETE it (stale)
//
// Two things it must never do: touch the GLOBAL scope, and touch a rule an
// operator wrote by hand. A machine can hold sandboxes Huddle did not create;
// widening their policy — or the whole machine's — is not ours to do.
//
// Allow-all only holds together with per-box identity: it removes the premise
// the proxy's fleet merge rested on, so the two land in the same release (ADR §6).

import { db } from '../db';
import * as ops from './ops';
import type { ActualPolicyRule } from './ops';
import { isValidSandboxName, type Scope } from './protocol';
import { hasSandboxIdentity } from './registry';

/** sbx' wildcard network target — the single rule Huddle authors per sandbox. */
export const ALLOW_ALL_TARGET = '*';

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
  /** The sandboxes Huddle manages, i.e. the ones this run was allowed to touch. */
  sandboxes: string[];
  created: number;
  deleted: number;
  failed: number;
  actions: ReconcileAction[];
  error?: string;
}

/**
 * The sandboxes Huddle created. `sbx ls` says what exists on the machine; the
 * identity minted at create (registry.ts, ADR §7.1) says which of those are
 * ours. A box Huddle never created has no identity row and keeps its own policy.
 *
 * Existence is the whole question here, so ask the predicate: the reconciler has
 * no use for a sandbox' secret and should not be a place one can be read from.
 */
async function managedSandboxes(): Promise<string[]> {
  const all = await ops.list();
  return all.map((s) => s.name).filter((name) => isValidSandboxName(name) && hasSandboxIdentity(name));
}

/** Normalise like parsePolicyLsJson does, so `host:443` matches a bare host. */
function normalizeTarget(t: string): string {
  return t.trim().toLowerCase().replace(/:\d+$/, '');
}

/** Per sandbox, the allow targets and the deny targets HUDDLE put in its sbx
 * policy, kept apart. */
interface ProjectedTargets {
  allow: Set<string>;
  deny: Set<string>;
}

/**
 * Per sandbox, the targets HUDDLE put in its sbx policy — everything else there
 * is the operator's and stays. An sbx rule carries no author, so Huddle's own
 * ruleset is the only fingerprint there is: the old projection wrote a box' own
 * allow/deny domains into that box' scope, as the SAME decision, and nothing
 * else. A target is only a fingerprint of Huddle's hand when the decision
 * matches too — one query per decision, so an operator's `allow bad.com` is
 * never mistaken for ours just because Huddle's table separately denies
 * bad.com (that denial was never mirrored into sbx as an allow, and dropping
 * the operator's rule on that basis would be deleting a rule we never wrote).
 *
 * The gap this leaves is deliberate rather than hidden: a rule already deleted
 * from Huddle's table is no longer recognisable and its sbx rule stays behind.
 * A leftover allow is inert under allow-all; a leftover deny is not, and shows
 * up as sbx refusing traffic Huddle permits.
 */
function projectedTargets(managed: Set<string>): Map<string, ProjectedTargets> {
  const out = new Map<string, ProjectedTargets>();
  const entryFor = (containerId: string): ProjectedTargets => {
    let entry = out.get(containerId);
    if (!entry) out.set(containerId, (entry = { allow: new Set(), deny: new Set() }));
    return entry;
  };
  const load = (status: 'allow' | 'deny'): void => {
    const rows = db
      .prepare(`SELECT domain, container_id FROM rules WHERE status = ?`)
      .all(status) as { domain: string; container_id: string | null }[];
    for (const r of rows) {
      if (!r.container_id || !managed.has(r.container_id)) continue;
      entryFor(r.container_id)[status].add(normalizeTarget(r.domain));
    }
  };
  load('allow');
  load('deny');
  return out;
}

/**
 * Converge every Huddle-managed sandbox on a single allow-all rule. Idempotent:
 * a second run over an already-converged machine performs no sbx call that
 * mutates. Never throws for an enforcement gap — everything lands in the report,
 * so the UI/CLI can be honest about what happened.
 */
export async function reconcile(opts: { dryRun?: boolean } = {}): Promise<ReconcileReport> {
  const dryRun = !!opts.dryRun;
  const report: ReconcileReport = {
    ok: false,
    dryRun,
    sandboxes: [],
    created: 0,
    deleted: 0,
    failed: 0,
    actions: [],
  };

  // Is sbx there at all? Ask before anything mutating.
  try {
    await ops.version();
  } catch (err) {
    report.error = (err as Error).message;
    return report;
  }

  // Without the box list we would not know whose policy we are editing, so a
  // failed `sbx ls` aborts rather than falling back to a wider scope.
  let names: string[];
  try {
    names = await managedSandboxes();
  } catch (err) {
    report.error = (err as Error).message;
    return report;
  }
  report.sandboxes = names;
  if (names.length === 0) {
    report.ok = true;
    return report;
  }

  let actual: ActualPolicyRule[];
  try {
    actual = await ops.policyListAll();
  } catch (err) {
    report.error = (err as Error).message; // can't diff safely → abort (don't blind-create)
    return report;
  }

  const projected = projectedTargets(new Set(names));

  for (const name of names) {
    const scope: Scope = { kind: 'sandbox', name };
    // parsePolicyLsJson has already dropped org/system and inactive rules, which
    // is what keeps an operator's non-editable policy out of reach here.
    const mine = actual.filter((r) => r.scope.kind === 'sandbox' && r.scope.name === name);
    const allowAll = mine.filter((r) => r.action === 'allow' && r.target === ALLOW_ALL_TARGET);
    const keepId = allowAll.length > 0 ? allowAll[0].id : null;

    if (keepId === null) {
      await create(report, dryRun, scope);
    }

    // A `deny *` is not the mirror of our rule — it is an operator locking the box
    // down, and dropping it would widen the box without anyone asking.
    //
    // The decision has to match too, not just the target: Huddle's table saying
    // "deny bad.com" is not evidence that an `allow bad.com` sitting in sbx is
    // ours — the projection only ever wrote a target under the same decision it
    // recorded, so an opposite-decision rule on the same target is someone
    // else's, however it got there.
    const ours = (r: ActualPolicyRule): boolean => {
      if (r.action === 'allow' && r.target === ALLOW_ALL_TARGET) return true;
      const proj = projected.get(name);
      return (r.action === 'allow' ? proj?.allow.has(r.target) : proj?.deny.has(r.target)) === true;
    };

    // sbx removes a rule by ID and one rule can list several targets, so an ID is
    // only ours to delete when every target under it is — otherwise the
    // operator's target would go with it.
    const byId = new Map<string, ActualPolicyRule[]>();
    for (const r of mine) {
      const list = byId.get(r.id);
      if (list) list.push(r);
      else byId.set(r.id, [r]);
    }
    for (const [id, rules] of byId) {
      if (id === keepId) continue;
      if (!rules.every(ours)) continue;
      await remove(report, dryRun, id, rules, scope);
    }
  }

  report.ok = report.failed === 0;
  return report;
}

async function create(report: ReconcileReport, dryRun: boolean, scope: Scope): Promise<void> {
  const act: ReconcileAction = { op: 'create', action: 'allow', target: ALLOW_ALL_TARGET, scope, ok: true };
  if (dryRun) {
    report.actions.push(act);
    report.created++;
    return;
  }
  try {
    await ops.policySet({ scope, action: 'allow', target: ALLOW_ALL_TARGET });
    report.actions.push(act);
    report.created++;
  } catch (err) {
    report.actions.push({ ...act, ok: false, error: (err as Error).message });
    report.failed++;
  }
}

async function remove(
  report: ReconcileReport,
  dryRun: boolean,
  id: string,
  rules: ActualPolicyRule[],
  scope: Scope
): Promise<void> {
  // One action per sbx rule ID, listing every target that ID carried — the call
  // takes the ID, so reporting per target would claim calls we never made.
  const act: ReconcileAction = {
    op: 'delete',
    action: rules[0].action,
    target: rules.map((r) => r.target).join(', '),
    scope,
    ok: true,
  };
  if (dryRun) {
    report.actions.push(act);
    report.deleted++;
    return;
  }
  try {
    await ops.policyRemove(id, scope);
    report.actions.push(act);
    report.deleted++;
  } catch (err) {
    report.actions.push({ ...act, ok: false, error: (err as Error).message });
    report.failed++;
  }
}
