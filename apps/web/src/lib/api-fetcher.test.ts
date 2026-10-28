import { afterEach, describe, expect, jest, test } from "bun:test";

import { restoreRealTimers } from "@stll/property-testing/fake-timers";
import { rejectionOf } from "@stll/property-testing/rejection";

import { webApiClientOptions } from "@/lib/api";

const originalFetch = globalThis.fetch;

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("Request aborted");

const installHungFetch = () => {
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          reject(abortReason(signal));
          return;
        }
        signal?.addEventListener("abort", () => reject(abortReason(signal)), {
          once: true,
        });
      }),
    originalFetch,
  );
};

afterEach(() => {
  restoreRealTimers();
  globalThis.fetch = originalFetch;
});

describe("web API fetcher timeout policy", () => {
  test("aborts a hung request at the default bound", async () => {
    jest.useFakeTimers();
    installHungFetch();

    const pending = webApiClientOptions.fetcher("https://example.test", {});
    jest.advanceTimersByTime(30_000);

    expect(await rejectionOf(pending)).toMatchObject({ name: "TimeoutError" });
  });

  test("keeps the caller abort effective", async () => {
    installHungFetch();
    const controller = new AbortController();
    const pending = webApiClientOptions.fetcher("https://example.test", {
      signal: controller.signal,
    });
    const reason = new Error("caller stopped request");
    controller.abort(reason);

    expect(await rejectionOf(pending)).toBe(reason);
  });

  test("uses a per-call timeout override", async () => {
    jest.useFakeTimers();
    installHungFetch();

    const pending = webApiClientOptions.fetcher("https://example.test", {
      timeoutMs: 5,
    });
    jest.advanceTimersByTime(5);

    expect(await rejectionOf(pending)).toMatchObject({ name: "TimeoutError" });
  });
});
