import { panic, Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

/** Return a measurement while rolling back every write it made. */
export const withQueryPerfRollback = async <T>(
  database: GatedTestDb,
  run: (tx: TransactionOf<GatedTestDb>) => Promise<T>,
): Promise<T> => {
  class MeasurementComplete extends TaggedError("MeasurementComplete")<{
    message: string;
    value: T;
  }> {}
  const result = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (tx) => {
        const value = await run(tx);
        throw new MeasurementComplete({
          message: "Rollback measurement",
          value,
        });
      }),
    catch: (error) => error,
  });
  if (result.isOk()) {
    return panic("A query-perf rollback transaction cannot commit");
  }
  if (!MeasurementComplete.is(result.error)) {
    throw result.error;
  }
  return result.error.value;
};

/**
 * A task keeps its transaction callbacks as savepoints inside the fixture's
 * rollback transaction. A callback's read-only declaration is enforced by
 * PostgreSQL; restore read-write at the parent before the next callback.
 */
export const rollbackTaskDatabase = (
  database: GatedTestDb,
  tx: TransactionOf<GatedTestDb>,
) =>
  new Proxy(database, {
    get: (_source, property) => {
      if (property === "transaction") {
        return async <T>(
          run: (nested: TransactionOf<GatedTestDb>) => Promise<T>,
        ) => {
          const value = await tx.transaction(run);
          await tx.execute(sql`SET TRANSACTION READ WRITE`);
          return value;
        };
      }
      const value: unknown = Reflect.get(tx, property, tx);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => Reflect.apply(value, tx, args);
    },
  });
