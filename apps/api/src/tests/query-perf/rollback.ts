import { panic, Result, TaggedError } from "better-result";

import type { TransactionOf } from "@/api/db/scoped";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

/**
 * Return a measurement, rolling back every write it made when `rollBack`
 * asks for it and keeping them otherwise.
 */
export const withQueryPerfRollbackWhen = async <T>(
  database: Pick<GatedTestDb, "transaction">,
  run: (tx: TransactionOf<GatedTestDb>) => Promise<T>,
  rollBack: (value: T) => boolean,
): Promise<{ value: T; rolledBack: boolean }> => {
  class MeasurementComplete extends TaggedError("MeasurementComplete")<{
    message: string;
    value: T;
  }> {}
  const result = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (tx) => {
        const value = await run(tx);
        if (!rollBack(value)) {
          return value;
        }
        throw new MeasurementComplete({
          message: "Rollback measurement",
          value,
        });
      }),
    catch: (error) => error,
  });
  if (result.isOk()) {
    return { value: result.value, rolledBack: false };
  }
  if (!MeasurementComplete.is(result.error)) {
    throw result.error;
  }
  return { value: result.error.value, rolledBack: true };
};

/** Return a measurement while rolling back every write it made. */
export const withQueryPerfRollback = async <T>(
  database: Pick<GatedTestDb, "transaction">,
  run: (tx: TransactionOf<GatedTestDb>) => Promise<T>,
): Promise<T> => {
  const { value, rolledBack } = await withQueryPerfRollbackWhen(
    database,
    run,
    () => true,
  );
  return rolledBack
    ? value
    : panic("A query-perf rollback transaction cannot commit");
};
