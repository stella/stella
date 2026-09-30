import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbRetryConfig, ScopedDb } from "@/api/db/safe-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

export const toSafeDbMock =
  (scopedDb: ScopedDb): SafeDb =>
  async <T>(
    callback: (transaction: Transaction) => Promise<T>,
    _retry?: SafeDbRetryConfig,
  ) => {
    const result = await Result.tryPromise(
      async () => await scopedDb(callback),
    );
    return result;
  };

export const createScopedDbMock = (tx: unknown) => {
  let callCount = 0;

  const scopedDb: ScopedDb = async <T>(
    callback: (transaction: Transaction) => Promise<T>,
  ) => {
    callCount += 1;
    // Tests provide only the transaction members touched by the handler.
    const transaction =
      typeof tx === "object" && tx !== null
        ? {
            execute: async () => {
              await Promise.resolve();
            },
            ...tx,
          }
        : {
            execute: async () => {
              await Promise.resolve();
            },
          };
    return await callback(asTestRaw<Transaction>(transaction));
  };

  return {
    getCallCount: () => callCount,
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
  };
};

// Query fixtures provide the rows matching their select boundary. Keep the
// awaitable builder shape intact for locking and bounded reads.
export const createSelectQueryMock = <TRow>(rows: TRow[]) => {
  const limit = (count: number) => {
    const selected = rows.slice(0, count);
    return Object.assign(Promise.resolve(selected), {
      for: async () => selected,
    });
  };
  return {
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve(rows), {
          limit,
          orderBy: () => ({ limit }),
        }),
    }),
  };
};
