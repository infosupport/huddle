// The dependency-free parts of the control channel: which paths it owns, and
// how a feed version is computed and compared.
//
// Separate from ./routes and ./feed for the same reason ../rule-match is
// separate from ../rules — these import nothing, so they can be tested anywhere,
// including a devcontainer where better-sqlite3 has no binding. The path
// predicate in particular decides whether a request is authenticated as the
// gateway or waved through, and that is not something to leave resting on a
// suite that only runs in CI.

import crypto from 'crypto';

/**
 * Does this path belong to the control channel?
 *
 * Exact match or a `/`-delimited prefix — NOT `startsWith('/control')`, which
 * would also claim `/controlpanel` and any other route that merely begins with
 * those letters. The direction of that mistake matters: api.ts waves through
 * everything outside /api/ as a static asset, so a path this predicate declines
 * is unauthenticated. Over-matching costs a 401 on an unrelated route;
 * under-matching would publish the control channel.
 */
export function isControlPath(pathOnly: string): boolean {
  return pathOnly === '/control' || pathOnly.startsWith('/control/');
}

/**
 * The version a conditional request is presenting. A client may quote the ETag
 * and an intermediary may mark it weak, so compare on the bare value — a
 * well-behaved conditional request must never be missed and re-served.
 */
export function presentedVersion(ifNoneMatch: string | string[] | undefined): string {
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch;
  return (raw ?? '').replace(/^W\//, '').replace(/"/g, '').trim();
}

/**
 * Version a feed by hashing the body as served, rather than by a counter or a
 * timestamp: it needs no state on either side, it survives a Node restart, and
 * it cannot report "unchanged" for content that did change. Truncated to 32 hex
 * chars — this identifies a payload, it does not authenticate one.
 */
export function feedVersion(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}
