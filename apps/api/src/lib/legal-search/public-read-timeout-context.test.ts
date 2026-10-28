import { Result } from "better-result";
import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";

import {
  beginPublicRead,
  runWithPublicReadScope,
  runWithPublicReadStatementTimeout,
} from "./public-read-timeout-context";

test("public-read admission waits for parallel transaction cleanup after rejection", async () => {
  const entered = Promise.withResolvers<() => void>();
  const failure = new DOMException("Read cancelled", "AbortError");
  let settled = false;
  const scope = Result.tryPromise({
    try: async () =>
      await runWithPublicReadScope({ budgetMs: 1000 }, async () => {
        runWithPublicReadStatementTimeout({ budgetMs: 500 }, () => {
          entered.resolve(beginPublicRead());
        });
        return await Promise.reject(failure);
      }),
    catch: (error: unknown) => error,
  }).then((outcome) => {
    settled = true;
    return outcome;
  });
  const finish = await entered.promise;
  await setImmediate();
  expect(settled).toBe(false);
  finish();
  expect(await scope).toEqual(Result.err(failure));
  expect(settled).toBe(true);
});

test("transactions cannot start after their admission scope settles", async () => {
  // Bind the continuation while its admission context is active.
  const late = await runWithPublicReadScope({ budgetMs: 1000 }, async () => {
    const runInScope = AsyncLocalStorage.snapshot();
    return () => runInScope(beginPublicRead);
  });
  expect(late).toThrow("Public read started after its admission scope settled");
});
