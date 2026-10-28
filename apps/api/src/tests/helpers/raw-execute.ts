import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { NoopLogger } from "drizzle-orm/logger";
import {
  PgAsyncPreparedQuery,
  PgAsyncRaw,
  PgDialect,
} from "drizzle-orm/pg-core";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

type RawExecute = PgAsyncDatabase<PgQueryResultHKT>["execute"];
type RawExecuteQuery = Parameters<RawExecute>[0];
type RawExecuteMode = ConstructorParameters<typeof PgAsyncPreparedQuery>[3];

export const createTestRawExecute = (
  execute: (query: SQL, mode: RawExecuteMode) => Promise<unknown>,
): RawExecute => {
  function executeQuery<TRow extends unknown[] = unknown[]>(
    query: RawExecuteQuery,
    mode: "arrays",
  ): PgAsyncRaw<TRow[]>;
  function executeQuery<TRow extends object = Record<string, unknown>>(
    query: RawExecuteQuery,
    mode: "objects",
  ): PgAsyncRaw<TRow[]>;
  function executeQuery(
    query: RawExecuteQuery,
    mode?: "raw",
  ): PgAsyncRaw<unknown>;
  function executeQuery(query: RawExecuteQuery, mode: RawExecuteMode = "raw") {
    const statement =
      typeof query === "string" ? sql.raw(query) : query.getSQL();
    const compiled = dialect.sqlToQuery(statement);
    const prepared = new PgAsyncPreparedQuery(
      async () => await execute(statement, mode),
      compiled,
      undefined,
      mode,
      new NoopLogger(),
      undefined,
      undefined,
      undefined,
      undefined,
    );
    return new PgAsyncRaw(prepared, statement, compiled);
  }
  return executeQuery;
};
