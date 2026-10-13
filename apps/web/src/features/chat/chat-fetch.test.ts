import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

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
