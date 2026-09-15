// Writing down what the gateway decided, on Huddle Node.
//
// The gateway answers a request from its own copy of the policy and then says
// what that implied: rules to touch, hosts to file as `requested`, audit rows to
// write. This is the other end of that — the only place those writes happen now
// that the proxy runs in a process with no database.
//
// It is deliberately dumb. Nothing here re-decides anything: the effect list is
// the decision, already made, and re-evaluating it against a policy that may
// have changed in the meantime would silently answer a question nobody asked.
//
// The one thing that DOES need care is identity. A blocked host is filed as a
// new rule here, and the audit row for the request that triggered it has to
// point at that rule — but the gateway could not know its id when it wrote the
// entry. So an audit refers to the effect that mints it (`ruleFromEffect`), and
// this module fills in the id the database assigned.

import { db, logAudit, updateAuditResponse } from '../db';
import { notifyStateChanged } from '../events';
import type { RuleRow } from '../rule-match';
import type { PolicyEffect } from './decide';
import type { ReportBody } from './feed';
import { parseSudoEntry } from './sudo-entry';

let stmts: ReturnType<typeof prepareStmts> | null = null;

function prepareStmts() {
  return {
    // COLLATE NOCASE for the same reason the reader had it: rules are stored
    // lowercase, but an operator-created row need not be, and reading back the
    // row we just inserted must not miss it.
    selectPerContainer: db.prepare<[string, string]>(
      `SELECT id, domain, status, expires_at, container_id, path_pattern, path_mode FROM rules WHERE domain = ? COLLATE NOCASE AND container_id = ?`
    ),
    selectGlobal: db.prepare<[string]>(
      `SELECT id, domain, status, expires_at, container_id, path_pattern, path_mode FROM rules WHERE domain = ? COLLATE NOCASE AND container_id IS NULL`
    ),
    touchRule: db.prepare<[number]>(
      `UPDATE rules SET last_seen = unixepoch(), request_count = request_count + 1 WHERE id = ?`
    ),
    setLastPath: db.prepare<[string, number]>(
      `UPDATE rules SET last_path = ? WHERE id = ?`
    ),
    insertRequested: db.prepare<[string, string | null]>(
      `INSERT OR IGNORE INTO rules (domain, container_id, status) VALUES (?, ?, 'requested')`
    ),
    insertRequestedPath: db.prepare<[string, string | null, string]>(
      `INSERT OR IGNORE INTO rules (domain, container_id, status, path_pattern) VALUES (?, ?, 'requested', ?)`
    ),
    resetExpired: db.prepare<[number]>(
      `UPDATE rules SET status='requested', updated_at=unixepoch() WHERE id=?`
    ),
  };
}

function s() {
  if (!stmts) stmts = prepareStmts();
  return stmts;
}

/** Only used by tests, which open a fresh database per suite. */
export function __resetApplyStmts(): void {
  stmts = null;
}

// File a host (or an unknown subpath group) as 'requested' and return the id the
// database gave it. INSERT OR IGNORE deliberately swallows a concurrent insert,
// so the row is read back rather than assumed: two proxied requests for the same
// blocked host must end up pointing at the same rule.
function createRequestedRule(effect: Extract<PolicyEffect, { kind: 'create-requested' }>): number | null {
  const { selectPerContainer, selectGlobal, insertRequested, insertRequestedPath, touchRule, setLastPath } = s();
  const { domain, containerId, pathPattern, lastPath } = effect;
  const inserted = pathPattern === null
    ? insertRequested.run(domain, containerId)
    : insertRequestedPath.run(domain, containerId, pathPattern);
  // Only a genuinely new row is news for the operator's UI.
  if (inserted.changes > 0) notifyStateChanged();
  const rows = (containerId
    ? selectPerContainer.all(domain, containerId)
    : selectGlobal.all(domain)) as RuleRow[];
  const created = rows.find(r => r.path_pattern === pathPattern);
  if (!created) return null;
  if (lastPath !== null) setLastPath.run(lastPath, created.id);
  touchRule.run(created.id);
  return created.id;
}

/**
 * Perform a batch of effects, in order. Returns the rule id each effect minted,
 * or null for the effects that mint nothing — the audits in the same report
 * index into this array to find the row they belong to.
 */
export function applyEffects(effects: PolicyEffect[]): (number | null)[] {
  const { touchRule, setLastPath, resetExpired } = s();
  return effects.map((effect) => {
    try {
      switch (effect.kind) {
        case 'touch': touchRule.run(effect.ruleId); return null;
        case 'set-last-path': setLastPath.run(effect.path, effect.ruleId); return null;
        case 'reset-expired': resetExpired.run(effect.ruleId); return null;
        case 'create-requested': return createRequestedRule(effect);
      }
    } catch (err) {
      // One bad effect (a rule the operator deleted a moment ago, say) must not
      // cost the rest of the batch — including the audit rows behind it.
      console.error('[control] effect failed:', (err as Error).message);
      return null;
    }
  });
}

// ── Audit refs ───────────────────────────────────────────────────────────────
//
// The gateway logs a request and completes it with the response later, possibly
// in a different batch. It refers to the row by its own counter, so the mapping
// to real database ids lives here. Keyed by session too: a restarted gateway
// starts counting at 1 again, and without that prefix a fresh ref would collide
// with a stale mapping and attach a response to an unrelated request.
//
// Bounded, because an in-flight request whose response never arrives (a tunnel
// held open for hours, a gateway killed mid-request) would otherwise leak an
// entry forever. Oldest out first: Map preserves insertion order, and a ref old
// enough to be evicted belongs to a request nobody is still waiting on.

const MAX_AUDIT_REFS = 20_000;
const auditIds = new Map<string, number>();

function rememberAuditId(session: string, ref: number, id: number): void {
  if (auditIds.size >= MAX_AUDIT_REFS) {
    const oldest = auditIds.keys().next();
    if (!oldest.done) auditIds.delete(oldest.value);
  }
  auditIds.set(`${session}:${ref}`, id);
}

/** Only used by tests. */
export function __resetAuditRefs(): void {
  auditIds.clear();
}

export interface ApplyResult {
  effects: number;
  audits: number;
  auditUpdates: number;
  /** Updates whose request was never logged here — a dropped or evicted ref. */
  orphanUpdates: number;
  sudoAudits: number;
}

/** Apply one report from the gateway: effects first, then the audits that reference them. */
export function applyReport(body: ReportBody): ApplyResult {
  const created = applyEffects(body.effects ?? []);

  let audits = 0;
  for (const a of body.audits ?? []) {
    const entry = { ...a.entry };
    if (a.ruleFromEffect !== undefined) entry.ruleId = created[a.ruleFromEffect] ?? null;
    const id = logAudit(entry);
    if (id !== null) { rememberAuditId(body.session, a.ref, id); audits++; }
  }

  let auditUpdates = 0;
  let orphanUpdates = 0;
  for (const u of body.auditUpdates ?? []) {
    const key = `${body.session}:${u.ref}`;
    const id = auditIds.get(key);
    if (id === undefined) { orphanUpdates++; continue; }
    updateAuditResponse(id, u.response);
    // A request is completed once; holding the ref after that only crowds out
    // the ones still in flight.
    auditIds.delete(key);
    auditUpdates++;
  }

  // Sudo lines are relayed by the proxy, which answers the endpoint the
  // devcontainer posts to (proxy-self.ts). They stand alone — no effect to
  // reference, no response to fill in later — so they are simply parsed and
  // filed. The containerId is the gateway's IP→container lookup; the `container`
  // field the forwarder puts in its body has never been trusted and still isn't.
  let sudoAudits = 0;
  for (const line of body.sudoAudits ?? []) {
    const row = parseSudoEntry(line.entry);
    if (!row || !line.containerId) continue;
    logAudit({ containerId: line.containerId, domain: 'sudo', action: row.action, method: null, path: row.path });
    sudoAudits++;
  }
  // Once per batch, not per line: a `sudo` burst is a handful of rows arriving
  // in the same flush. Ordinary proxied audits deliberately do NOT notify (they
  // never did) — every request would push the portal.
  if (sudoAudits > 0) notifyStateChanged();

  if (body.dropped) {
    console.warn(`[control] gateway dropped ${body.dropped} queued item(s) — Huddle Node was unreachable`);
  }

  return { effects: created.length, audits, auditUpdates, orphanUpdates, sudoAudits };
}
