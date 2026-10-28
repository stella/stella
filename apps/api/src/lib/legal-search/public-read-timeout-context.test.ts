import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";

import {
  runWithPublicReadScope,
  runWithPublicReadStatementTimeout,
  withPublicReadIo,
} from "./public-read-timeout-context";

for (const boundary of ["timeout", "scope"] as const) {
  test(`public-read admission waits for ${boundary} operation cleanup after rejection`, async () => {
    const entered = Promise.withResolvers<{ operation: Promise<unknown> }>();
    const finish = Promise.withResolvers<undefined>();
    const failure = new DOMException("Read cancelled", "AbortError");
    let settled = false;
    const scope = runWithPublicReadScope({ budgetMs: 1000 }, async () => {
      const run = async () =>
        await withPublicReadIo("database", async () => await finish.promise);
      const operation =
        boundary === "timeout"
          ? runWithPublicReadStatementTimeout({ budgetMs: 500 }, run)
          : runWithPublicReadScope({ budgetMs: 500 }, run);
      entered.resolve({ operation });
      return await Promise.reject(failure);
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
  if (Result.isError(late)) {
    panic("Expected a settled public-read capability");
  }
  const result = await Result.tryPromise({
    try: late.value,
    catch: (error: unknown) => error,
  });
  expect(result).toMatchObject({
    status: "error",
    error: { message: "Public read started after its admission scope settled" },
  });
});

for (const failureAt of [
  "request",
  "consume",
  "consume-and-cleanup",
] as const) {
  test(`public-read scope preserves ${failureAt} failure after cleanup`, async () => {
    const failure = new DOMException("Read failed", "NetworkError");
    const cleanupFailure = new DOMException("Cleanup failed", "NetworkError");
    let cancellations = 0;
    const outcome = await runWithPublicReadScope(
      { budgetMs: 1000 },
      async () =>
        await withPublicReadIo(
          "corpus-index",
          async (io) =>
            await io.fetch(
              "https://corpus.fixture/read",
              { timeoutMs: 1000 },
              async () => {
                if (
                  failureAt === "consume" ||
                  failureAt === "consume-and-cleanup"
                ) {
                  return await Promise.reject(failure);
                }
                return "read";
              },
              async () => {
                if (failureAt === "request") {
                  return await Promise.reject(failure);
                }
                return new Response(
                  new ReadableStream<Uint8Array>({
                    cancel: async () => {
                      cancellations += 1;
                      if (failureAt === "consume-and-cleanup") {
                        return await Promise.reject(cleanupFailure);
                      }
                    },
                  }),
                );
              },
            ),
        ),
    );
    expect(outcome).toEqual(Result.err(failure));
    expect(cancellations).toBe(failureAt === "request" ? 0 : 1);
  });
}

test("public-read transport propagates cleanup failure after successful consumption", async () => {
  const failure = new DOMException("Cleanup failed", "NetworkError");
  const result = await Result.tryPromise({
    try: async () =>
      await withPublicReadIo(
        "corpus-index",
        async (io) =>
          await io.fetch(
            "https://corpus.fixture/read",
            { timeoutMs: 1000 },
            async () => "read",
            async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  cancel: async () => await Promise.reject(failure),
                }),
              ),
          ),
      ),
    catch: (error: unknown) => error,
  });
  expect(result).toEqual(Result.err(failure));
});
