// Huddle's SQLite handle: node:sqlite plus the one thing it does not ship.
//
// Huddle used better-sqlite3 until this file existed. That was the only native
// runtime dependency in the whole product, and it cost more than it earned:
//
//   - Huddle Node ships as a single executable (gateway/scripts/build-sea.mjs).
//     A .node file cannot be loaded out of a SEA blob — the dynamic loader needs
//     a real path — so it had to be written to ~/.huddle/runtime and dlopen'd
//     from there. Writing an executable into the user's home and loading it as
//     code is a local privilege-escalation primitive that then has to be
//     guarded rather than avoided.
//   - On macOS the hardened runtime refuses to dlopen an unsigned file that was
//     unpacked at runtime, and notarisation does not cover one.
//   - better-sqlite3 12.10.0 on Node 24 aborts non-deterministically during
//     teardown: Statement::~Statement() → RemoveEnvironmentCleanupHook,
//     assertion (env) != nullptr — the weak-callback destructor runs with no
//     entered V8 context. It reproduces bundled and unbundled alike, so it is a
//     property of the product, not of how it is packaged.
//
// node:sqlite's DatabaseSync is built into Node 24 and covers the API Huddle
// actually uses: prepare/run/get/all/exec/close, positional parameters only.
// Verified identical on the semantics this codebase depends on — run() returns
// {changes, lastInsertRowid} as numbers, get() returns undefined on a miss, and
// undefined/boolean bindings throw exactly as before.
//
// The one thing DatabaseSync has no equivalent for is better-sqlite3's
// transaction(), so it lives here.

import { DatabaseSync } from 'node:sqlite';

/** Distinct savepoint name per nesting depth. */
let savepointDepth = 0;

export class HuddleDatabase extends DatabaseSync {
  /**
   * Wraps `fn` so that calling the result runs it inside a transaction, exactly
   * as better-sqlite3's `db.transaction()` did: build once, invoke later,
   * arguments forwarded, return value passed through, and any throw rolls back
   * and rethrows.
   *
   * Nesting is the part that matters. applyParsedEnvelopes() opens a
   * transaction and calls importGroupEnvelope(), which opens one of its own —
   * and a plain BEGIN inside a BEGIN is an error in SQLite. So an inner call
   * uses a SAVEPOINT instead, which is what better-sqlite3 did too. Rolling the
   * inner one back leaves the outer transaction intact and still open, so the
   * caller decides whether the whole thing survives.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const nested = this.isTransaction;
      const savepoint = nested ? `huddle_sp_${++savepointDepth}` : '';

      this.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      try {
        const result = fn(...args);
        // RELEASE is the savepoint equivalent of COMMIT: it merges the inner
        // work into the enclosing transaction rather than writing to disk.
        this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (err) {
        // ROLLBACK TO leaves the savepoint itself in place, so it needs the
        // RELEASE too — otherwise the name leaks for the rest of the outer
        // transaction. Never let a rollback failure mask the real error.
        try {
          this.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        } catch { /* the original throw below is the one worth reporting */ }
        throw err;
      } finally {
        if (nested) savepointDepth--;
      }
    };
  }
}
