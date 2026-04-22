import { Result } from "better-result";

import type {
  SafeDb,
  SafeDbRetryConfig,
  ScopedDb,
  Transaction,
} from "@/api/db";

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

    // SAFETY: tests provide only the transaction members touched by the handler.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return await callback(tx as Transaction);
  };

  return {
    getCallCount: () => callCount,
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
  };
};
