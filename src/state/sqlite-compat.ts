/**
 * better-sqlite3 → node:sqlite compatibility shim.
 *
 * Why this exists: Node 26 advanced its native-module ABI past what
 * better-sqlite3@11 was compiled for, and the addon will not rebuild against
 * current V8 (node-gyp fails). Node ships its own SQLite — `node:sqlite` —
 * which works on Node 26. This wraps `DatabaseSync` to expose exactly the slice
 * of the better-sqlite3 API that Galvin actually calls.
 *
 * node:sqlite already provides everything Galvin needs on prepared statements
 * (`run`/`get`/`all`, with `run()` returning `{ changes, lastInsertRowid }`),
 * so `prepare`/`exec`/`close` pass straight through. Only `pragma()` and
 * `transaction()` are better-sqlite3-isms that node:sqlite lacks, so those are
 * emulated here.
 *
 * Intentionally NOT implemented — zero call sites in this repo (verified):
 *   pluck, iterate, raw, columns, expand, backup, function, aggregate,
 *   loadExtension, defaultSafeIntegers, named-parameter binding (all bindings
 *   are positional `?`). If a future caller needs one of these, add it HERE —
 *   do not reintroduce a dependency on the better-sqlite3 native addon.
 */

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncCtor, StatementSync } from "node:sqlite";

// Load node:sqlite via createRequire rather than a static `import`. Vite (used
// by vitest) ships a static list of Node built-ins that predates node:sqlite,
// so a static import makes it strip the "node:" prefix and fail resolving a
// package named "sqlite". A runtime require is opaque to Vite's resolver and
// works identically under tsx, vitest, and the compiled dist. The `import type`
// above is erased at compile time, so it never reaches Vite.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

/** Mirrors better-sqlite3's RunResult shape. node:sqlite returns numbers. */
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * Drop-in for `import Database from "better-sqlite3"`. Construct with a file
 * path (the only form Galvin uses). Downstream code keeps the better-sqlite3
 * static types via a cast at the single construction site in database.ts; this
 * class satisfies that surface at runtime.
 */
export default class Database {
  /** Underlying node:sqlite handle, exposed for advanced/debug use. */
  readonly handle: DatabaseSyncCtor;
  private txDepth = 0;

  constructor(filename: string, _options?: unknown) {
    // node:sqlite opens eagerly, like better-sqlite3's default.
    this.handle = new DatabaseSync(filename);
  }

  prepare(sql: string): StatementSync {
    return this.handle.prepare(sql);
  }

  exec(sql: string): this {
    this.handle.exec(sql);
    return this;
  }

  /**
   * better-sqlite3-style `pragma()`. Returns result rows as an array — e.g.
   * `pragma("integrity_check")` → `[{ integrity_check: "ok" }]`, matching what
   * database.ts indexes into. Setter pragmas (`journal_mode = WAL`, etc.)
   * return their resulting row(s) or `[]`; callers ignore those. Falls back to
   * `exec` for any pragma that cannot be prepared.
   */
  pragma(source: string): unknown[] {
    const sql = `PRAGMA ${source}`;
    try {
      return this.handle.prepare(sql).all();
    } catch {
      this.handle.exec(sql);
      return [];
    }
  }

  /**
   * better-sqlite3-style `transaction()`. Returns a function that runs `fn`
   * atomically: BEGIN/COMMIT at the top level, ROLLBACK on throw. Nested calls
   * use SAVEPOINTs so transactions compose instead of erroring with "cannot
   * start a transaction within a transaction" — matching better-sqlite3, which
   * also implements nesting via savepoints.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const depth = this.txDepth;
      const savepoint = `_galvin_sp_${depth}`;
      if (depth === 0) this.handle.exec("BEGIN");
      else this.handle.exec(`SAVEPOINT ${savepoint}`);
      this.txDepth = depth + 1;
      try {
        const result = fn(...args);
        this.txDepth = depth;
        if (depth === 0) this.handle.exec("COMMIT");
        else this.handle.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        this.txDepth = depth;
        if (depth === 0) {
          this.handle.exec("ROLLBACK");
        } else {
          this.handle.exec(`ROLLBACK TO ${savepoint}`);
          this.handle.exec(`RELEASE ${savepoint}`);
        }
        throw err;
      }
    };
  }

  close(): void {
    this.handle.close();
  }
}
