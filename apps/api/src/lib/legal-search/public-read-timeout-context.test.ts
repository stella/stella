import { Result } from "better-result";
import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";

import {
  runWithPublicReadScope,
  runWithPublicReadStatementTimeout,
  withPublicReadIo,
} from "./public-read-timeout-context";

for (const boundary of ["timeout", "scope"] as const) {
  test(`public-read admission waits for ${boundary} operation cleanup after rejection`, async () => {
    const entered = Promise.withResolvers<{ operation: Promise<void> }>();
    const finish = Promise.withResolvers<undefined>();
    const failure = new DOMException("Read cancelled", "AbortError");
    let settled = false;
    const scope = Result.tryPromise({
      try: async () =>
        await runWithPublicReadScope({ budgetMs: 1000 }, async () => {
          const run = async () =>
            await withPublicReadIo(
              "database",
              async () => await finish.promise,
            );
          const operation =
            boundary === "timeout"
              ? runWithPublicReadStatementTimeout({ budgetMs: 500 }, run)
              : runWithPublicReadScope({ budgetMs: 500 }, run);
          entered.resolve({ operation });
          return await Promise.reject(failure);
        }),
      catch: (error: unknown) => error,
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    const { operation } = await entered.promise;
    await setImmediate();
    expect(settled).toBe(false);
    finish.resolve(undefined);
    await operation;
    expect(await scope).toEqual(Result.err(failure));
    expect(settled).toBe(true);
  });
}

test("a transport capability cannot start reads after its admission scope settles", async () => {
  const late = await runWithPublicReadScope(
    { budgetMs: 1000 },
    async () =>
      await withPublicReadIo(
        "corpus-index",
        async (io) => async () =>
          io.fetch(
            "http://localhost/unused",
            { timeoutMs: 1000 },
            async (response) => await response.text(),
          ),
      ),
  );
  const result = await Result.tryPromise({
    try: late,
    catch: (error: unknown) => error,
  });
  expect(result).toMatchObject({
    status: "error",
    error: { message: "Public read started after its admission scope settled" },
  });
});
