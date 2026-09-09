/**
 * Types for node:sqlite.
 *
 * TEMPORARY, and deletable the moment @types/node is upgraded. This project
 * runs Node 24 but pins @types/node to 20.19.x, and node:sqlite's declarations
 * only landed in @types/node 22.5. So the module exists and works at runtime
 * while TypeScript claims it does not exist at all.
 *
 * Upgrading @types/node is the real fix; it needs registry access this
 * container does not currently have. When that happens, delete this file — the
 * upstream declarations are more complete and would otherwise be shadowed by
 * these.
 *
 * The shape deliberately mirrors @types/better-sqlite3's two-generic
 * `prepare<BindParameters, Result>`, because ~105 call sites already pass the
 * bind-tuple that way (`db.prepare<[string, number]>(...)`). Matching it keeps
 * the driver swap invisible to every one of them.
 *
 * Only what Huddle actually calls is declared. Adding a method here does not
 * make it exist; check against the running Node version first.
 */
declare module 'node:sqlite' {
  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  class StatementSync<
    BindParameters extends unknown[] = unknown[],
    Result = unknown,
  > {
    run(...params: BindParameters): StatementResultingChanges;
    get(...params: BindParameters): Result | undefined;
    all(...params: BindParameters): Result[];
    /** Named parameters may be passed without their @ / : / $ prefix. */
    setAllowBareNamedParameters(enabled: boolean): void;
    /** Return INTEGER columns as BigInt instead of number. Huddle leaves this off. */
    setReadBigInts(enabled: boolean): void;
  }

  interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
  }

  class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    /** True between BEGIN and COMMIT/ROLLBACK. Drives savepoint nesting. */
    readonly isTransaction: boolean;
    prepare<BindParameters extends unknown[] = unknown[], Result = unknown>(
      sql: string,
    ): StatementSync<BindParameters, Result>;
    exec(sql: string): void;
    open(): void;
    close(): void;
  }
}
