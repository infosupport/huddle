// The shapes of the rows that cross a process boundary, with no database behind
// them.
//
// db.ts opens SQLite at import time and pulls in better-sqlite3, a native
// module. The gateway has neither after the split (docs/ADR-huddle-node-split.md)
// yet still describes audit rows — it decides what to log, Node writes it down.
// Importing db.ts just for a type would put a native binding in the gateway's
// import graph, so the types live here and db.ts re-exports them for its own
// callers.

/** A request the proxy handled, as it is logged. */
export interface AuditEntry {
  containerId: string | null;
  domain: string;
  port?: number | null;
  action: string;
  ruleId?: number | null;
  /**
   * Gateway-side only, and never stored: the id of a rule this very request
   * filed does not exist yet, so the gateway points at the effect that mints it
   * (see control/plane.ts) and Huddle Node resolves it into `ruleId` on arrival.
   */
  ruleRef?: number | null;
  method?: string | null;
  path?: string | null;
  reqHeaders?: string | null;
  reqBody?: string | null;
  resStatus?: number | null;
  resHeaders?: string | null;
  resBody?: string | null;
}

/** The response half of an audit row, filled in once the request completes. */
export interface AuditResponse {
  reqBody?: string | null;
  resStatus?: number | null;
  resHeaders?: string | null;
  resBody?: string | null;
}
