import { QueryClient } from "@tanstack/react-query";
import { describe, expect, mock, test } from "bun:test";

import {
  CriticalQueryTimeoutError,
  ensureCriticalQueryData,
  prefetchNonCriticalQuery,
} from "@/lib/react-query";

const wait = async (ms: number) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

describe("ensureCriticalQueryData", () => {
  test("cancels timed-out critical queries and reports the query key", async () => {
    const queryClient = new QueryClient();
    const queryKey = ["workspaces", "ws_1"] as const;
    let abortReceived = false;
    let fetchStarted = false;

    const result = ensureCriticalQueryData(
      queryClient,
      {
        queryKey,
        queryFn: async ({ signal }) => {
          fetchStarted = true;
          return await new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                abortReceived = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      },
      { timeoutMs: 1 },
    );

    let caughtError: unknown;
    try {
      await result;
    } catch (error) {
      caughtError = error;
    }

    expect(fetchStarted).toBe(true);
    expect(CriticalQueryTimeoutError.is(caughtError)).toBe(true);
    if (!CriticalQueryTimeoutError.is(caughtError)) {
      throw new Error("Expected CriticalQueryTimeoutError");
    }

    expect(caughtError.queryKey).toEqual(queryKey);
    expect(caughtError.message).toContain(JSON.stringify(queryKey));

    await wait(0);

    expect(abortReceived).toBe(true);
    expect(
      queryClient.getQueryCache().find({ queryKey })?.state.fetchStatus,
    ).toBe("idle");
  });

  test("does not cancel queries that resolve before the timeout", async () => {
    const queryClient = new QueryClient();
    const queryKey = ["workspaces", "ws_2"] as const;
    let abortReceived = false;

    const result = await ensureCriticalQueryData(
      queryClient,
      {
        queryKey,
        queryFn: async ({ signal }) => {
          signal.addEventListener("abort", () => {
            abortReceived = true;
          });
          return "ok";
        },
      },
      { timeoutMs: 1 },
    );

    await wait(5);

    expect(result).toBe("ok");
    expect(abortReceived).toBe(false);
    expect(queryClient.getQueryData<string>(queryKey)).toBe("ok");
  });
});

describe("prefetchNonCriticalQuery", () => {
  test("reports errors through onError", async () => {
    const queryClient = new QueryClient();
    const expectedError = new Error("boom");
    const onError = mock((_error: unknown): void => {});

    await prefetchNonCriticalQuery(
      queryClient,
      {
        queryKey: ["failing-query"],
        queryFn: async () => {
          throw expectedError;
        },
      },
      onError,
    );

    expect(onError).toHaveBeenCalledWith(expectedError);
  });

  test("does not report successful prefetches", async () => {
    const queryClient = new QueryClient();
    const onError = mock((_error: unknown): void => {});

    await prefetchNonCriticalQuery(
      queryClient,
      {
        queryKey: ["successful-query"],
        queryFn: async () => "ok",
      },
      onError,
    );

    expect(onError).not.toHaveBeenCalled();
  });
});
