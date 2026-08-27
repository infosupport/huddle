// ── Automatic sbx sync (both directions) ──────────────────────────────────────
// 1. Huddle → sbx: on rule changes and sandbox lifecycle, reconcile the policy
//    projection automatically (debounced). Huddle stays the source of truth.
// 2. sbx → Huddle: poll each sandbox's `sbx policy log --json` for BLOCKED
//    destinations and file them as `requested` rows so they surface in the portal
//    for approval (the discovery loop; ADR §4.2). Approving writes a rule →
//    reconcile → sbx allows it.
// Everything here is best-effort: if sbx is not reachable, calls throw
// and are swallowed quietly so normal operation is never blocked.

import { db } from '../db';
import { notifyStateChanged } from '../events';
import { reconcile } from './reconcile';
import * as ops from './ops';
import { isValidSandboxName } from './protocol';
import { setKnownSandboxes } from './registry';
import { matchDomain } from '../rule-match';

const DEBOUNCE_MS = Number(process.env.HUDDLE_SBX_RECONCILE_DEBOUNCE_MS ?? '1500');
const POLL_MS = Number(process.env.HUDDLE_SBX_INGEST_INTERVAL_MS ?? '20000');
const QUIET = process.env.HUDDLE_SBX_AUTOSYNC_DEBUG !== '1';

let debounceTimer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;

function log(...a: unknown[]): void {
  if (!QUIET) console.log('[sbx-sync]', ...a);
}

/**
 * Reconcile Huddle → sbx, debounced + coalesced (many rule edits → one sync).
 * Safe to call on every rule mutation / sandbox lifecycle event.
 */
export function scheduleReconcile(reason: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runReconcile, DEBOUNCE_MS);
  log('scheduled reconcile:', reason);
}

async function runReconcile(): Promise<void> {
  debounceTimer = null;
  if (running) { rerun = true; return; } // coalesce a burst into one trailing run
  running = true;
  try {
    const rep = await reconcile({ dryRun: false });
    if (rep.error) log('reconcile skipped:', rep.error);
    else log(`reconcile: +${rep.created} -${rep.deleted} (failed ${rep.failed})`);
  } catch (err) {
    log('reconcile error:', (err as Error).message);
  } finally {
    running = false;
    if (rerun) { rerun = false; scheduleReconcile('coalesced'); }
  }
}

const insertRequested = db.prepare<[string, string | null]>(
  `INSERT OR IGNORE INTO rules (domain, container_id, status) VALUES (?, ?, 'requested')`
);

/**
 * Pull blocked destinations from each sandbox's policy log and file them as
 * `requested` rows (scoped to the sandbox). Returns how many new rows were added.
 */
export async function ingestPending(): Promise<number> {
  // `sbx policy log --json` returns ALL vms in one document, each entry carrying
  // its own vm_name — so fetch once (global scope, no --sandbox) and scope by it.
  let raw: string;
  try {
    raw = await ops.policyLog({ kind: 'global' });
  } catch (err) {
    log('ingest skipped (policy log failed):', (err as Error).message);
    return 0;
  }
  // Existing concrete decisions (allow/deny), global or per-sandbox. A blocked
  // host already covered by one of these is NOT pending — e.g. a domain the
  // operator DENIED (sbx blocks it, but it's a settled decision, not a request),
  // or one covered by a global/wildcard rule. Only truly-undecided hosts pend.
  const decided = db
    .prepare(`SELECT domain, container_id FROM rules WHERE status IN ('allow','deny')`)
    .all() as { domain: string; container_id: string | null }[];
  const alreadyDecided = (host: string, sandbox: string): boolean => {
    const h = host.toLowerCase();
    for (const r of decided) {
      if (r.container_id !== null && r.container_id !== sandbox) continue; // global or this sandbox
      const pat = r.domain.toLowerCase();
      if (pat === h) return true;
      if (pat.startsWith('*.') && matchDomain(pat, h)) return true;
    }
    return false;
  };

  let added = 0;
  for (const d of ops.parsePolicyLogJson(raw)) {
    // The log DOES tell us which box was blocked (vm_name) — file the pending
    // under that specific sandbox so the operator approves it for that box.
    // (Huddle's PROXY can't attribute a live request, but the LOG can; the proxy
    // side is handled by the fleet-merge in checkFleetRule.)
    if (!d.sandbox || !isValidSandboxName(d.sandbox)) continue;
    if (alreadyDecided(d.domain, d.sandbox)) continue; // already allowed/denied → not pending
    const info = insertRequested.run(d.domain, d.sandbox);
    added += info.changes;
  }
  if (added > 0) {
    log(`ingested ${added} blocked → requested`);
    notifyStateChanged();
  }
  return added;
}

let poller: NodeJS.Timeout | null = null;

/** Start the background poller: periodic ingest + a follow-up reconcile. */
export function startAutoSync(): void {
  if (poller) return;
  const tick = async () => {
    // Keep the known-sandbox set fresh so the proxy's fleet-merge is accurate.
    try { setKnownSandboxes((await ops.list()).map((s) => s.name)); } catch { /* sbx down */ }
    const added = await ingestPending();
    // Newly-approved rules and drift are pushed on the next reconcile; also run a
    // reconcile each tick so external drift self-heals even without rule edits.
    scheduleReconcile(added > 0 ? 'ingest' : 'poll');
  };
  poller = setInterval(() => void tick(), POLL_MS);
  if (poller.unref) poller.unref();
  log(`auto-sync started (ingest every ${POLL_MS}ms, reconcile debounce ${DEBOUNCE_MS}ms)`);
}

export function stopAutoSync(): void {
  if (poller) { clearInterval(poller); poller = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
}
