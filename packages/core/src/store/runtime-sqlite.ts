import { createRequire } from "node:module";

type SqlValue = string | number | bigint | Uint8Array | null;

interface SqlStatement<T = unknown> {
  run(...params: SqlValue[]): unknown;
  get<R = T>(...params: SqlValue[]): R | null;
  all<R = T>(...params: SqlValue[]): R[];
}

export interface RuntimeDatabase {
  exec(sql: string): void;
  query<T = unknown, P extends SqlValue[] = SqlValue[]>(sql: string): SqlStatement<T>;
  prepare<T = unknown>(sql: string): SqlStatement<T>;
  transaction<T extends unknown[]>(fn: (rows: T) => void): (rows: T) => void;
  close(): void;
}

function loadDatabaseConstructor(): new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): unknown;
    get<T = unknown>(...params: SqlValue[]): T | undefined;
    all<T = unknown>(...params: SqlValue[]): T[];
  };
  close(): void;
} {
  const require = createRequire(import.meta.url);

  if (process.versions.bun) {
    return require("bun:sqlite").Database;
  }

  return require("node:sqlite").DatabaseSync;
}

export function openRuntimeDatabase(path: string): RuntimeDatabase {
  const raw = new (loadDatabaseConstructor())(path);
  const query = <T = unknown>(sql: string): SqlStatement<T> => {
    const statement = raw.prepare(sql);
    return {
      run: (...params) => statement.run(...params),
      get: <R = T>(...params: SqlValue[]) =>
        (statement.get(...params) as R | undefined) ?? null,
      all: <R = T>(...params: SqlValue[]) => statement.all<R>(...params),
    };
  };

  return {
    exec: (sql) => raw.exec(sql),
    query,
    prepare: query,
    transaction: <T extends unknown[]>(fn: (rows: T) => void) => (rows: T) => {
      raw.exec("BEGIN IMMEDIATE");
      try {
        fn(rows);
        raw.exec("COMMIT");
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => raw.close(),
  };
}
