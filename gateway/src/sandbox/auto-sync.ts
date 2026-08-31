// ── Automatic sbx sync ────────────────────────────────────────────────────────
// Huddle → sbx, and only that direction: keep every Huddle-managed sandbox on
// its single allow-all rule (reconcile.ts), debounced. Huddle's proxy decides
// the rest.
//
// There used to be a second, opposite direction here — poll every sandbox'
// `sbx policy log --json` for BLOCKED destinations and file them as `requested`
// rows (the discovery loop, ADR §4.2). It was how a sandbox' blocked hosts
// reached the portal back when the proxy could not tell one box from another.
// Per-box identity (docs/ADR-sbx-identity.md) removed the need and reconcile
// removed the source: a Huddle-managed box is `allow *` in sbx, so sbx blocks
// nothing for it and every denial it has comes from Huddle's proxy, which files
// it against the right box on its own.
//
// What that poll saw afterwards was not traffic. `blocked_hosts` is a CUMULATIVE
// aggregate keyed by host with a `count_since` — not a queue — so it kept
// re-filing hosts a box had been blocked for once, long ago, possibly before
// Huddle managed it, possibly on a box since deleted. Dismissing such a row put
// it straight back on the next tick. And an UNMANAGED box, the only case the
// poll still genuinely covered, is one reconcile deliberately refuses to touch
// (see managedSandboxes) — so approving what it filed would have changed
// nothing anyway.
//
// Everything here is best-effort: if sbx is not reachable, calls throw and are
// swallowed quietly so normal operation is never blocked.

import { reconcile } from './reconcile';

const DEBOUNCE_MS = Number(process.env.HUDDLE_SBX_RECONCILE_DEBOUNCE_MS ?? '1500');
// Named for what it does now; the old name still works so an existing env keeps
// meaning what it meant.
const POLL_MS = Number(
  process.env.HUDDLE_SBX_POLL_INTERVAL_MS ?? process.env.HUDDLE_SBX_INGEST_INTERVAL_MS ?? '20000',
);
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

let poller: NodeJS.Timeout | null = null;

/**
 * Start the background poller: a periodic reconcile, so external drift
 * self-heals even when no rule is edited.
 */
export function startAutoSync(): void {
  if (poller) return;
  poller = setInterval(() => scheduleReconcile('poll'), POLL_MS);
  if (poller.unref) poller.unref();
  log(`auto-sync started (reconcile every ${POLL_MS}ms, debounce ${DEBOUNCE_MS}ms)`);
}

export function stopAutoSync(): void {
  if (poller) { clearInterval(poller); poller = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
}
