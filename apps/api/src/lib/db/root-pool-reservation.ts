import { panic } from "better-result";
import type { SQL } from "bun";

import { runCountedTransaction } from "@/api/lib/db-query-counter";
import { runTransactionsInCallerContext } from "@/api/lib/db/caller-async-context";
import type { RootPoolWindow } from "@/api/lib/observability/root-pool-window";

type RootPoolReservationOptions<T, TSession extends { release: () => void }> = {
  reserve: () => Promise<TSession>;
  window: RootPoolWindow;
  work: (session: TSession) => Promise<T>;
};

/** Observe the reservation boundary, excluding BEGIN and query execution. */
export const withRootPoolReservation = async <
  T,
  TSession extends { release: () => void },
>({
  reserve,
  window,
  work,
}: RootPoolReservationOptions<T, TSession>) => {
  const started = window.requested();
  let session: TSession | undefined;
  try {
    session = await reserve();
    window.acquired(started);
    return await work(session);
  } finally {
    if (session === undefined) {
      window.failed();
    } else {
      session.release();
      window.released();
    }
  }
};

// Native begin already reserves exclusively. Using the public reservation
// boundary measures acquisition before BEGIN, while ordinary queries keep
// Bun's native pipelining and scheduling.
export const instrumentRootPoolTransactions = (
  client: SQL,
  window: RootPoolWindow,
) => {
  const reserve = client.reserve.bind(client);
  const begin = async <const T>(
    optionsOrCallback: string | SQL.TransactionContextCallback<T>,
    callback?: SQL.TransactionContextCallback<T>,
  ): Promise<SQL.ContextCallbackResult<T>> => {
    if (typeof optionsOrCallback !== "string") {
      return await runCountedTransaction(
        async () =>
          await withRootPoolReservation({
            reserve,
            window,
            work: async (session) =>
              await runTransactionsInCallerContext(session).begin(
                optionsOrCallback,
              ),
          }),
      );
    }
    if (callback === undefined) {
      return panic("begin(options) needs a transaction callback");
    }
    return await runCountedTransaction(
      async () =>
        await withRootPoolReservation({
          reserve,
          window,
          work: async (session) =>
            await runTransactionsInCallerContext(session).begin(
              optionsOrCallback,
              callback,
            ),
        }),
    );
  };
  Object.defineProperties(client, {
    begin: { configurable: true, value: begin },
    transaction: { configurable: true, value: begin },
  });
  return client;
};
