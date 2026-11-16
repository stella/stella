import { Result } from "better-result";
import { afterEach, describe, expect, jest, test } from "bun:test";

import { SSE_SILENCE_BOUND_MS } from "@stll/api-contract/sse-heartbeat";

import { chatFetchClient } from "./chat-fetch";
import { findChatRequestError } from "./chat-request-error";

const originalFetch = globalThis.fetch;

describe("chat transport failures", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each([
    { cause: new TypeError("Failed to fetch"), kind: "connection_failed" },
    { cause: new DOMException("Timeout", "TimeoutError"), kind: "timed_out" },
  ] as const)(
    "classifies $kind when init overrides an aborted Request signal",
    async ({ cause, kind }) => {
      const requestController = new AbortController();
      requestController.abort();
      const overridingController = new AbortController();
      let effectiveSignalAborted: boolean | undefined;
      globalThis.fetch = Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          effectiveSignalAborted = init?.signal?.aborted;
          throw cause;
        },
        { preconnect: originalFetch.preconnect },
      );
      const request = new Request("https://example.test/v1/chat/", {
        signal: requestController.signal,
      });
      const outcome = await Result.tryPromise({
        try: async () =>
          await chatFetchClient(request, {
            signal: overridingController.signal,
          }),
        catch: (error) => error,
      });
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(findChatRequestError(outcome.error)?.kind).toBe(kind);
        expect(findChatRequestError(outcome.error)?.cause).toBe(cause);
      }
      expect(effectiveSignalAborted).toBe(false);
    },
  );

  test.each([
    { cause: new TypeError("Failed to fetch"), kind: "connection_failed" },
    { cause: new DOMException("Timeout", "TimeoutError"), kind: "timed_out" },
  ] as const)(
    "classifies $kind without losing its cause",
    async ({ cause, kind }) => {
      let requests = 0;
      globalThis.fetch = Object.assign(
        async () => {
          requests += 1;
          throw cause;
        },
        { preconnect: originalFetch.preconnect },
      );
      const outcome = await Result.tryPromise({
        try: async () => await chatFetchClient("https://example.test/v1/chat/"),
        catch: (error) => error,
      });
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(findChatRequestError(outcome.error)?.kind).toBe(kind);
        expect(findChatRequestError(outcome.error)?.cause).toBe(cause);
      }
      expect(requests).toBe(1);
    },
  );

  test.each([{ source: "init" }, { source: "request" }] as const)(
    "keeps a caller abort from $source distinct from service failure",
    async ({ source }) => {
      const cause = new DOMException("Stopped by caller", "AbortError");
      const controller = new AbortController();
      controller.abort(cause);
      globalThis.fetch = Object.assign(
        async () => {
          throw cause;
        },
        {
          preconnect: originalFetch.preconnect,
        },
      );
      const url = "https://example.test/v1/chat/";
      const outcome = await Result.tryPromise({
        try: async () =>
          await (source === "init"
            ? chatFetchClient(url, { signal: controller.signal })
            : chatFetchClient(new Request(url, { signal: controller.signal }))),
        catch: (error) => error,
      });
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error).toBe(cause);
        expect(findChatRequestError(outcome.error)).toBeUndefined();
      }
    },
  );
});

describe("chat stream deadlines", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A request the server never answers; it fails when its signal aborts. */
  const neverAnswered = () => {
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        const signal = init?.signal;
        const fail = () => {
          reject(signal?.reason);
        };
        if (signal?.aborted === true) {
          fail();
        }
        signal?.addEventListener("abort", fail);
        return await promise;
      },
      { preconnect: originalFetch.preconnect },
    );
  };

  /** A stream the server opened and then says nothing on. */
  const silentStream = () => {
    const released: unknown[] = [];
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel(reason: unknown) {
              released.push(reason);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      { preconnect: originalFetch.preconnect },
    );
    return released;
  };

  test("headers that never arrive time the request out", async () => {
    jest.useFakeTimers();
    neverAnswered();
    const outcome = Result.tryPromise({
      try: async () => await chatFetchClient("https://example.test/v1/chat/"),
      catch: (error) => error,
    });
    // Far past any wait for headers: the request has no stream to be alive.
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    const failed = await outcome;
    expect(failed.isErr()).toBe(true);
    if (failed.isErr()) {
      expect(findChatRequestError(failed.error)?.kind).toBe("timed_out");
    }
  });

  test("a refusal whose body stalls still reaches the page as its status", async () => {
    jest.useFakeTimers();
    const released: unknown[] = [];
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel(reason: unknown) {
              released.push(reason);
            },
          }),
          { status: 503, statusText: "Service Unavailable" },
        ),
      { preconnect: originalFetch.preconnect },
    );
    const outcome = Result.tryPromise({
      try: async () => await chatFetchClient("https://example.test/v1/chat/"),
      catch: (error) => error,
    });
    // The refusal is read once the fetch has answered.
    for (let turn = 0; turn < 16; turn += 1) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(60 * 60 * 1000);
    const refused = await outcome;
    expect(refused.isErr() ? refused.error : undefined).toMatchObject({
      status: 503,
    });
    expect(released).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a stop ends a stream at once, however recently it spoke", async () => {
    jest.useFakeTimers();
    const released = silentStream();
    const stop = new AbortController();
    const response = await chatFetchClient("https://example.test/v1/chat/", {
      signal: stop.signal,
    });
    const reader = response.body?.getReader();
    const read = Result.tryPromise({
      try: async () => await reader?.read(),
      catch: (error) => error,
    });
    const reason = new DOMException("Stopped by the member", "AbortError");
    stop.abort(reason);
    const ended = await read;
    expect(ended.isErr() ? ended.error : undefined).toBe(reason);
    expect(released).toEqual([reason]);
    // Nothing is left counting down on a stream the member closed.
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a stream silent past the bound fails as timed out and is released", async () => {
    jest.useFakeTimers();
    const released = silentStream();
    const response = await chatFetchClient("https://example.test/v1/chat/");
    const reader = response.body?.getReader();
    const read = Result.tryPromise({
      try: async () => await reader?.read(),
      catch: (error) => error,
    });
    jest.advanceTimersByTime(SSE_SILENCE_BOUND_MS);
    const ended = await read;
    expect(ended.isErr() ? ended.error : undefined).toMatchObject({
      name: "TimeoutError",
    });
    expect(released).toHaveLength(1);
  });
});
