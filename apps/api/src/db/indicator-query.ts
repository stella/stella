import { panic, Result } from "better-result";

import type { IngestionTransactionRunner } from "../lib/replay-safe-ingestion";

export type IndicatorQuery = (
  statement: string,
  parameters?: readonly (string | number | null)[],
) => Promise<readonly unknown[]>;

type BoundedIndicatorQueryOptions<Transaction> = {
  runInTransaction: IngestionTransactionRunner<Transaction>;
  transactionQuery: (tx: Transaction) => IndicatorQuery;
  readTimeoutMs: number;
};

/**
 * A logical indicator timeout cannot cancel SQL. Each read therefore owns a
 * short transaction with a server-side budget, and settle waits for cancellation
 * and rollback before the shared session can start a batch transaction.
 */
export const createBoundedIndicatorQuery = <Transaction>({
  runInTransaction,
  transactionQuery,
  readTimeoutMs,
}: BoundedIndicatorQueryOptions<Transaction>) => {
  if (!Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0) {
    panic("Indicator read timeout must be finite and positive");
  }
  let pending = Promise.resolve();
  const query: IndicatorQuery = (statement, parameters) => {
    // The online repair session is reserved: its catalog reads cannot open
    // overlapping transactions even when indicators are evaluated together.
    const read = pending.then(
      async () =>
        await runInTransaction(async (tx) => {
          const execute = transactionQuery(tx);
          await execute("SELECT set_config('statement_timeout', $1, true)", [
            `${Math.ceil(readTimeoutMs)}ms`,
          ]);
          return await execute(statement, parameters);
        }),
    );
    // Failure still rejects read; this tail only tracks when cleanup finished.
    pending = Result.tryPromise(async () => await read).then(() => undefined);
    return read;
  };
  return { query, settle: async () => await pending };
};
