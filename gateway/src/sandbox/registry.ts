// ── Known sandbox names ───────────────────────────────────────────────────────
// A small cache of the sandbox names sbx currently knows about, refreshed by the
// auto-sync poller (`sbx ls`). Huddle's proxy uses it to evaluate a sandbox-fleet
// request against the MERGE of global rules + every individual sandbox's rules
// (it can't attribute a live request to one box). Reconciliation uses it to know
// which per-container rules are actually sandbox-scoped.

let known = new Set<string>();

export function setKnownSandboxes(names: Iterable<string>): void {
  known = new Set(names);
}

export function knownSandboxNames(): Set<string> {
  return known;
}

export function isKnownSandbox(name: string | null | undefined): boolean {
  return !!name && known.has(name);
}
