import { afterEach, describe, expect, jest, test } from "bun:test";

import { createApiClient } from "@stll/api-client";
import { restoreRealTimers } from "@stll/property-testing/fake-timers";
import { rejectionOf } from "@stll/property-testing/rejection";

import { webApiClientOptions } from "@/lib/api";

const originalFetch = globalThis.fetch;

type TestRoutes = {
  v1: {
    result: {
      get: {
        body: unknown;
        params: unknown;
        query: unknown;
        headers: unknown;
        response: { 200: { ready: boolean } };
      };
    };
  };
};

const testClient = () =>
  createApiClient<TestRoutes>("https://example.test", {
    fetcher: webApiClientOptions.fetcher,
  }).v1;

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
    const pending = testClient().result.get({
      fetch: { signal: controller.signal },
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

  test("bounds JSON body consumption after headers arrive", async () => {
    jest.useFakeTimers();
    const headersArrived = Promise.withResolvers<undefined>();
    const bodyRead = Promise.withResolvers<undefined>();
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        headersArrived.resolve(undefined);
        const signal = init?.signal;
        let sentPartialBody = false;
        return new Response(
          new ReadableStream(
            {
              start(stream) {
                signal?.addEventListener(
                  "abort",
                  () => stream.error(abortReason(signal)),
                  { once: true },
                );
              },
              pull(stream) {
                if (sentPartialBody) {
                  return;
                }
                sentPartialBody = true;
                stream.enqueue(new TextEncoder().encode('{"ready":'));
                bodyRead.resolve(undefined);
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "application/json" } },
        );
      },
      originalFetch,
    );

    const pending = testClient().result.get({ fetch: { timeoutMs: 5 } });
    await headersArrived.promise;
    await bodyRead.promise;
    jest.advanceTimersByTime(5);

    expect(await rejectionOf(pending)).toMatchObject({ name: "TimeoutError" });
  });

  test("parses a completed JSON response", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({ ready: true }, { headers: { "x-result": "ready" } }),
      originalFetch,
    );

    const result = await testClient().result.get();

    expect(result.data).toEqual({ ready: true });
    expect(result.headers.get("x-result")).toBe("ready");
  });
});
