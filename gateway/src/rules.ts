// Rule maintenance that belongs to the database, on Huddle Node.
//
// What used to live here — reading the rules that apply to a request, deciding,
// and writing down what the decision implied — is gone, in three pieces:
//
//   control/select.ts   selecting the applicable rules, from a policy feed
//   control/decide.ts   the decision itself, pure
//   control/apply.ts    the writes it implies
//
// The gateway makes the decision in its own process, from a policy Huddle Node
// publishes, and reports back what to write (docs/ADR-huddle-node-split.md).
// There is deliberately no second, SQL-based copy of that logic left behind for
// a combined process: two definitions of the firewall means one of them drifts,
// and it is the one nobody runs in production.
//
// The rule vocabulary and the pure host/path matching live in ./rule-match.

import { db } from './db';
import type { RuleStatus } from './rule-match';

// Ensure a domain is in path-allowlist mode after a path-scoped rule is created.
// A path rule is inert over HTTPS unless a host-only marker (path_pattern IS NULL)
// with path_mode=1 exists: the proxy only sees the host at CONNECT and admits the
// tunnel (so MITM can read the path) only for a path-mode domain. Without the
// marker the CONNECT is refused and the path rule never fires (finding #6a).
// Idempotent: creates the marker, or promotes an existing host-only row to one
// (a stale 'requested' placeholder becomes a default-deny marker; an explicit
// allow/deny keeps its decision).
export function ensurePathModeMarker(domain: string, containerId: string | null): void {
  const marker = db
    .prepare(
      `SELECT id, status, path_mode FROM rules WHERE domain = ? COLLATE NOCASE AND COALESCE(container_id, '') = COALESCE(?, '') AND path_pattern IS NULL`
    )
    .get(domain, containerId) as { id: number; status: RuleStatus; path_mode: number } | undefined;
  if (!marker) {
    db.prepare(
      `INSERT INTO rules (domain, container_id, status, path_pattern, path_mode) VALUES (?, ?, 'deny', NULL, 1)`
    ).run(domain, containerId);
  } else if (marker.path_mode !== 1) {
    const status = marker.status === 'requested' ? 'deny' : marker.status;
    db.prepare(`UPDATE rules SET path_mode = 1, status = ?, updated_at = unixepoch() WHERE id = ?`).run(status, marker.id);
  }
}
