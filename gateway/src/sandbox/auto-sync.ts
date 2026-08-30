// ── Automatic sbx sync (both directions) ──────────────────────────────────────
// 1. Huddle → sbx: keep every Huddle-managed sandbox on its single allow-all
//    rule (reconcile.ts), debounced. Huddle's proxy decides the rest.
// 2. sbx → Huddle: poll each sandbox's `sbx policy log --json` for BLOCKED
//    destinations and file them as `requested` rows so they surface in the portal
//    for approval (the discovery loop; ADR §4.2). A Huddle-managed sandbox is
//    allow-all in sbx and so blocks nothing itself — its denials come from
//    Huddle's proxy — but a box created before Huddle managed it still reports
//    here, and the rows are the same either way.
// Everything here is best-effort: if sbx is not reachable, calls throw
// and are swallowed quietly so normal operation is never blocked.

import type { Statement } from 'better-sqlite3';
import { db } from '../db';
import { notifyStateChanged } from '../events';
import { reconcile } from './reconcile';
import * as ops from './ops';
import { isValidSandboxName } from './protocol';
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
 * Reconcile the sbx side, debounced + coalesced (many rule edits → one sync).
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

// Prepared on first use, not at import. better-sqlite3 validates SQL against the
// live schema in .prepare(), and importing this module is what boot-node.ts does
// BEFORE it calls initDb() — imports are hoisted, so a top-level prepare here
// throws `no such table: rules` on a database that has never been initialised.
// Invisible while the database lived in a long-lived container volume; the first
// boot of Huddle Node on a fresh host hits it every time.
let _insertRequested: Statement<[string, string | null]> | null = null;
function insertRequested(): Statement<[string, string | null]> {
  if (!_insertRequested) {
    _insertRequested = db.prepare<[string, string | null]>(
      `INSERT OR IGNORE INTO rules (domain, container_id, status) VALUES (?, ?, 'requested')`
    );
  }
  return _insertRequested;
}

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
    // The log tells us which box was blocked (vm_name) — file the pending under
    // that specific sandbox so the operator approves it for that box.
    if (!d.sandbox || !isValidSandboxName(d.sandbox)) continue;
    if (alreadyDecided(d.domain, d.sandbox)) continue; // already allowed/denied → not pending
    const info = insertRequested().run(d.domain, d.sandbox);
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
