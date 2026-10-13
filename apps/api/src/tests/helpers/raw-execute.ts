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

export const createTestRawExecute =
  (execute: (query: SQL) => Promise<unknown>) =>
  (query: Parameters<PgAsyncDatabase<PgQueryResultHKT>["execute"]>[0]) => {
    const statement =
      typeof query === "string" ? sql.raw(query) : query.getSQL();
    const compiled = dialect.sqlToQuery(statement);
    const prepared = new PgAsyncPreparedQuery(
      async () => await execute(statement),
      compiled,
      undefined,
      "raw",
      new NoopLogger(),
      undefined,
      undefined,
      undefined,
    );
    return new PgAsyncRaw(prepared, statement, compiled);
  };
