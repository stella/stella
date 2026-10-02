import { panic } from "better-result";
import type { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Runs every transaction callback on `client` in the async context of the
 * code that opened the transaction, and returns the same client.
 *
 * Bun's pool calls a `begin` callback when a connection becomes free, in
 * whatever async context that happens: a new connection's context (no
 * request) or that of the request that released a busy one. Everything the
 * callback does then reads another request's stores: its query count, its
 * request id, its log context. Under concurrent requests a request's
 * `x-db-queries` count gains or loses the statements of the transactions it
 * waited on. Capturing the caller's context when `begin` is called and
 * restoring it around the callback keeps each statement with the request that
 * issued it. Savepoints run inside the callback, so they follow.
 */
export const runTransactionsInCallerContext = (client: SQL): SQL => {
  const begin = client.begin.bind(client);
  const beginInCallerContext = async <const T>(
    optionsOrCallback: string | SQL.TransactionContextCallback<T>,
    callback?: SQL.TransactionContextCallback<T>,
  ): Promise<SQL.ContextCallbackResult<T>> => {
    const runInCaller = AsyncLocalStorage.snapshot();
    if (typeof optionsOrCallback !== "string") {
      return await begin(
        async (transaction) =>
          await runInCaller(optionsOrCallback, transaction),
      );
    }
    if (callback === undefined) {
      panic("begin(options) needs a transaction callback");
    }
    return await begin(
      optionsOrCallback,
      async (transaction) => await runInCaller(callback, transaction),
    );
  };
  Object.defineProperty(client, "begin", {
    configurable: true,
    value: beginInCallerContext,
  });
  return client;
};
