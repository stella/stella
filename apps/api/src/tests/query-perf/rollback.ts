import { panic, Result, TaggedError } from "better-result";

import type { TransactionOf } from "@/api/db/scoped";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

/** Return a measurement while rolling back every write it made. */
export const withQueryPerfRollback = async <T>(
  database: Pick<GatedTestDb, "transaction">,
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
