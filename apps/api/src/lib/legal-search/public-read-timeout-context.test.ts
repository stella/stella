import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";

import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

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
  expect(result).toMatchObject({
    status: "error",
    error: { _tag: "PublicReadCleanupError" },
  });
});

for (const consumption of ["unconsumed", "consumed", "failed"] as const) {
  test(`scoped public-read ${consumption} body preserves its result through cancellation settlement`, async () => {
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    try {
      const cleanupStarted = Promise.withResolvers<undefined>();
      const cleanupFinished = Promise.withResolvers<undefined>();
      const failure = new DOMException("Read failed", "NetworkError");
      const cleanupFailure = new DOMException("Cleanup failed", "NetworkError");
      let settled = false;
      let cancellations = 0;
      const scope = runWithPublicReadScope(
        { budgetMs: 1000 },
        async () =>
          await withPublicReadIo(
            "corpus-index",
            async (io) =>
              await io.fetch(
                "https://corpus.fixture/read",
                { timeoutMs: 1000 },
                async (response) => {
                  if (consumption === "consumed") {
                    return await response.text();
                  }
                  if (consumption === "failed") {
                    return await Promise.reject(failure);
                  }
                  return "read";
                },
                async () =>
                  new Response(
                    new ReadableStream<Uint8Array>({
                      start: (controller) => {
                        if (consumption === "consumed") {
                          controller.enqueue(new TextEncoder().encode("read"));
                          controller.close();
                        }
                      },
                      cancel: async () => {
                        cancellations += 1;
                        cleanupStarted.resolve(undefined);
                        await cleanupFinished.promise;
                        return await Promise.reject(cleanupFailure);
                      },
                    }),
                  ),
              ),
          ),
      ).then((outcome) => {
        settled = true;
        return outcome;
      });
      if (consumption !== "consumed") {
        await cleanupStarted.promise;
        await setImmediate();
        expect(settled).toBe(false);
        cleanupFinished.resolve(undefined);
      }
      const outcome = await scope;
      if (consumption === "unconsumed") {
        expect(outcome).toMatchObject({
          status: "error",
          error: { _tag: "PublicReadCleanupError" },
        });
      } else {
        expect(outcome).toEqual(
          consumption === "consumed" ? Result.ok("read") : Result.err(failure),
        );
      }
      expect(cancellations).toBe(consumption === "consumed" ? 0 : 1);
      expect(settled).toBe(true);
      const observations = logs.records.filter(
        ({ message }) => message === "public_read.body_cleanup_failed",
      );
      expect(observations).toHaveLength(consumption === "consumed" ? 0 : 1);
      expect(analytics.exceptions()).toHaveLength(
        consumption === "consumed" ? 0 : 1,
      );
      expect(
        JSON.stringify({
          logs: observations,
          captures: analytics.exceptions(),
          outcome,
        }),
      ).not.toContain("Cleanup failed");
    } finally {
      logs.restore();
      analytics.restore();
    }
  });
}

for (const cleanup of ["success", "failure"] as const) {
  test(`scoped abort preserves its reason through ${cleanup} cleanup`, async () => {
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    const controller = new AbortController();
    const started = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const failure = new DOMException("Read aborted", "AbortError");
    let settled = false;
    const scope = runWithPublicReadScope(
      { budgetMs: 1000, signal: controller.signal },
      async () =>
        await withPublicReadIo(
          "corpus-index",
          async (io) =>
            await io.fetch(
              "https://corpus.fixture/read",
              { timeoutMs: 1000 },
              async (response) => {
                controller.abort(failure);
                return await response.text();
              },
              async () =>
                new Response(
                  new ReadableStream<Uint8Array>({
                    cancel: async () => {
                      started.resolve(undefined);
                      await finish.promise;
                      if (cleanup === "failure") {
                        return await Promise.reject(
                          new DOMException(
                            "private cleanup detail",
                            "NetworkError",
                          ),
                        );
                      }
                      return;
                    },
                  }),
                ),
            ),
        ),
    ).then((outcome) => {
      settled = true;
      return outcome;
    });
    try {
      await started.promise;
      await setImmediate();
      expect(settled).toBe(false);
      finish.resolve(undefined);
      expect(await scope).toEqual(Result.err(failure));
      expect(
        logs.records.filter(
          ({ message }) => message === "public_read.body_cleanup_failed",
        ),
      ).toHaveLength(cleanup === "failure" ? 1 : 0);
      expect(analytics.exceptions()).toHaveLength(
        cleanup === "failure" ? 1 : 0,
      );
      expect(
        JSON.stringify({
          logs: logs.records,
          captures: analytics.exceptions(),
        }),
      ).not.toContain("private cleanup detail");
    } finally {
      finish.resolve(undefined);
      await scope;
      logs.restore();
      analytics.restore();
    }
  });
}
