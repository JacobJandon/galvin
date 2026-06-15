/**
 * Minimal ambient types for Node's built-in `node:sqlite`.
 *
 * The runtime is Node 26 (where node:sqlite is stable), but @types/node is
 * pinned at 20.x and ships no `sqlite` typings. Rather than bump @types/node
 * broadly (which can ripple type changes across the codebase), this declares
 * exactly the surface ./sqlite-compat.ts consumes. If sqlite-compat grows to
 * use more of the API, extend this declaration to match.
 */
declare module "node:sqlite" {
  type SupportedValue = null | number | bigint | string | Uint8Array;

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: SupportedValue[]): StatementResultingChanges;
    get(...params: SupportedValue[]): unknown;
    all(...params: SupportedValue[]): unknown[];
    iterate(...params: SupportedValue[]): IterableIterator<unknown>;
    columns(): Array<Record<string, unknown>>;
    setReadBigInts(enabled: boolean): void;
    setAllowBareNamedParameters(enabled: boolean): void;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
  }

  export class DatabaseSync {
    constructor(filename: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    open(): void;
    readonly location: string | null;
  }
}
