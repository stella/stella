import type { ScopedDb, Transaction } from "@/api/db";

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
    scopedDb,
  };
};
