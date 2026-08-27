// The firewall decision itself, as a pure function.
//
// `decide()` takes a snapshot of the rules that could apply to a request and
// returns two things: what the answer is, and which writes that answer implies.
// It touches no database, no clock and no event bus — the caller supplies `now`
// and performs the effects.
//
// The point is not testability (though it helps). It is that Huddle is being
// split into a host-side control plane and a containerized firewall gateway
// (docs/ADR-huddle-node-split.md), and the decision has to keep being made
// locally in the gateway: routing every proxied request through Huddle Node
// would put Node in the hot path and stop all egress the moment it is down.
// Separating "what is the answer" from "what must be written down" is what makes
// that possible — the answer only needs the snapshot, while the effects can be
// applied locally, batched, or shipped to whoever owns the database.
//
// The effects are not incidental bookkeeping, which is why they are modelled
// explicitly rather than left as side effects: filing a blocked host as
// `requested` is how the operator gets to see it at all, and the id of that
// freshly created row is what the audit entry refers to.

import { firstSegmentPattern, matchDomain, matchPath, type RuleRow, type RuleStatus } from '../rule-match';

export type Candidate = RuleRow & { domain_is_wildcard: boolean };

/**
 * Every rule that could possibly apply to one request, already fetched.
 *
 * Split by scope because scope decides specificity, and kept unfiltered by host
 * and path because that filtering is `decide()`'s job — a snapshot is a dumb
 * copy of rows, so it can equally well come from a SELECT or from a policy push.
 *
 * Airlock is expressed by construction rather than by a flag: an isolated
 * container gets no global fallback, so its reader leaves the two global arrays
 * empty and `decide()` never has to know the concept exists.
 */
export interface PolicySnapshot {
  perContainerExact: RuleRow[];
  perContainerWildcard: RuleRow[];
  globalExact: RuleRow[];
  globalWildcard: RuleRow[];
  /** The container the request came from; null for unattributed/global traffic. */
  containerId: string | null;
}

/**
 * A write the decision implies. `create-requested` is the one that carries
 * weight: it files a host (or an unknown subpath) for the operator to review,
 * and the row it creates is the one the decision's ruleId ends up referring to.
 */
export type PolicyEffect =
  | { kind: 'touch'; ruleId: number }
  | { kind: 'set-last-path'; ruleId: number; path: string }
  | { kind: 'reset-expired'; ruleId: number }
  | {
      kind: 'create-requested';
      domain: string;
      containerId: string | null;
      /** null files the host itself; a pattern files one group of subpaths. */
      pathPattern: string | null;
      /** A concrete example path to show the operator, or null. */
      lastPath: string | null;
    };

export interface PolicyDecision {
  status: RuleStatus;
  /**
   * The rule this decision came from, or null when there isn't one yet: a
   * `create-requested` effect mints the row, so the applier fills this in with
   * the id the database assigned.
   */
  ruleId: number | null;
  effects: PolicyEffect[];
}

// Specificity of a candidate rule. Higher = more specific = wins. Order:
// per-container > global; exact host > wildcard host; with path > without path.
function specificity(c: Candidate): number {
  let score = 0;
  if (c.container_id !== null) score += 4;
  if (!c.domain_is_wildcard) score += 2;
  if (c.path_pattern !== null && c.path_pattern !== '') score += 1;
  return score;
}

/**
 * Decide one request against a snapshot. `domain` must already be canonical
 * (lowercased at minimum) and `now` is unix seconds — passed in so expiry is
 * part of the input rather than a hidden read of the clock.
 */
export function decide(
  snapshot: PolicySnapshot,
  domain: string,
  path: string | null,
  now: number,
): PolicyDecision {
  // Collect all candidate rules: exact-host (per-container + global) and
  // wildcard-host (per-container + global). Then filter here, not in SQL.
  const candidates: Candidate[] = [];

  const addExact = (rows: RuleRow[]) => {
    for (const r of rows) {
      if (matchPath(r.path_pattern, path)) candidates.push({ ...r, domain_is_wildcard: false });
    }
  };
  const addWildcard = (rows: RuleRow[]) => {
    for (const r of rows) {
      if (matchDomain(r.domain, domain) && matchPath(r.path_pattern, path)) {
        candidates.push({ ...r, domain_is_wildcard: true });
      }
    }
  };

  // Insertion order is per-container before global: the sort below is stable, so
  // this is what breaks a tie between two otherwise equal candidates.
  addExact(snapshot.perContainerExact);
  addWildcard(snapshot.perContainerWildcard);
  addExact(snapshot.globalExact);
  addWildcard(snapshot.globalWildcard);

  if (candidates.length === 0) {
    // No match → create a host-only requested rule so the operator sees it in
    // the UI. (The path is not recorded: the operator chooses the scope
    // themselves.)
    return {
      status: 'requested',
      ruleId: null,
      effects: [{ kind: 'create-requested', domain, containerId: snapshot.containerId, pathPattern: null, lastPath: null }],
    };
  }

  // Pick the winning rule. A concrete decision (allow/deny) always outranks an
  // unresolved 'requested' placeholder, regardless of host-specificity —
  // otherwise a stale exact-host 'requested' row (auto-created on an earlier
  // block) would shadow a matching wildcard allow and keep the host blocked
  // even after the operator added a covering rule (finding #7). Among concrete
  // rules the most specific wins, and on equal specificity deny beats allow
  // (fail-closed).
  candidates.sort((a, b) => {
    const concrete = (st: RuleStatus) => (st === 'requested' ? 0 : 1);
    const c = concrete(b.status) - concrete(a.status);
    if (c !== 0) return c;
    const d = specificity(b) - specificity(a);
    if (d !== 0) return d;
    const rank = (st: RuleStatus) => (st === 'deny' ? 0 : st === 'allow' ? 1 : 2);
    return rank(a.status) - rank(b.status);
  });
  const best = candidates[0];

  // Path-allowlist mode: a host-only marker rule exists (path_mode=1). If only
  // that marker matched (no more specific path rule), this subpath is still
  // unknown: file it — grouped by the first path segment — as 'requested' so
  // the operator can review it, instead of silently rejecting it. A path rule
  // that does match (allow/deny/requested) is simply honored below.
  const inPathMode = candidates.some(c => c.path_pattern === null && c.path_mode === 1);
  if (inPathMode && path !== null) {
    const hostOnlyBest = best.path_pattern === null || best.path_pattern === '';
    if (hostOnlyBest) {
      // Only the host-only marker matched → unknown subpath: group by the first
      // segment and file it as requested. Keep the full path as a concrete
      // example for the operator.
      return {
        status: 'requested',
        ruleId: null,
        effects: [{
          kind: 'create-requested',
          domain,
          containerId: best.container_id,
          pathPattern: firstSegmentPattern(path),
          lastPath: path,
        }],
      };
    }
    if (best.status === 'requested') {
      // Existing requested group hit again → refresh the example path.
      return {
        status: 'requested',
        ruleId: best.id,
        effects: [{ kind: 'set-last-path', ruleId: best.id, path }, { kind: 'touch', ruleId: best.id }],
      };
    }
    // Otherwise an explicit allow/deny path rule won → normal handling.
  }

  if (best.status === 'allow' && best.expires_at !== null && best.expires_at < now) {
    return { status: 'requested', ruleId: null, effects: [{ kind: 'reset-expired', ruleId: best.id }] };
  }

  return { status: best.status, ruleId: best.id, effects: [{ kind: 'touch', ruleId: best.id }] };
}
