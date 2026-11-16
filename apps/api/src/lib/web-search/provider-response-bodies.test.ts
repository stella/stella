import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { deferred, settledWithin } from "@stll/test-kit";

import { createJinaFetcher, validateJinaKey } from "@/api/lib/web-search/jina";
import {
  createTavilyProvider,
  validateTavilyKey,
} from "@/api/lib/web-search/tavily";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

const testFetch = createTestFetch();
const validateKey = { jina: validateJinaKey, tavily: validateTavilyKey };

describe("provider response body ownership", () => {
  test.each([undefined, "jina-key"])(
    "Jina preserves its prefix and response metadata with key %s",
    async (apiKey) => {
      const cancelled = deferred<undefined>();
      const text = "Žluť😀tail";
      testFetch.set(
        asFetchMock(async (input, init) => {
          expect(input).toBe("https://r.jina.ai/https://example.com/page");
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe(
            apiKey ? `Bearer ${apiKey}` : null,
          );
          expect(headers.get("accept")).toBe("text/plain");
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(text));
              },
              cancel() {
                cancelled.resolve(undefined);
              },
            }),
            {
              headers: {
                "x-title": "Document title",
                "x-published-time": "2026-11-16",
                "x-url": "https://example.com/canonical",
              },
            },
          );
        }),
      );
      expect(
        await createJinaFetcher({ apiKey }).fetch({
          url: "https://example.com/page",
          maxChars: 5,
          signal: new AbortController().signal,
        }),
      ).toEqual({
        url: "https://example.com/canonical",
        title: "Document title",
        publishedAt: "2026-11-16",
        content: text.slice(0, 5),
        truncated: true,
        provider: "jina",
      });
      await cancelled.promise;
    },
  );

  test("Tavily reads only its existing 200-unit error prefix", async () => {
    const cancelled = deferred<undefined>();
    const text = `${"a".repeat(199)}😀remaining`;
    testFetch.set(
      asFetchMock(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(text));
              },
              cancel() {
                cancelled.resolve(undefined);
              },
            }),
            { status: 429 },
          ),
      ),
    );
    expect(
      await rejectionOf(
        createTavilyProvider({ apiKey: "tavily-key" }).search({
          query: "example",
          jurisdiction: "global",
          freshness: "any",
          maxResults: 1,
          signal: new AbortController().signal,
        }),
      ),
    ).toMatchObject({
      provider: "tavily",
      status: 429,
      message: `Tavily search failed (429): ${text.slice(0, 200)}`,
    });
    await cancelled.promise;
  });

  test("Tavily successful snippets and answers retain their full existing content", async () => {
    const text = "a".repeat(300);
    testFetch.set(
      asFetchMock(async () =>
        Response.json({
          answer: text,
          results: [
            {
              url: "https://example.com/document",
              title: "Document",
              content: text,
              score: 0.9,
            },
          ],
        }),
      ),
    );
    expect(
      await createTavilyProvider({ apiKey: "tavily-key" }).search({
        query: "example",
        jurisdiction: "global",
        freshness: "any",
        maxResults: 1,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      answer: text,
      results: [
        {
          id: "tavily-0",
          url: "https://example.com/document",
          title: "Document",
          snippet: text,
          source: "example.com",
          score: 0.9,
        },
      ],
    });
  });

  test("Jina keeps an HTTP refusal when discarding its body also fails", async () => {
    let cancelled = false;
    testFetch.set(
      asFetchMock(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
                throw new DOMException("Cleanup failed", "NetworkError");
              },
            }),
            { status: 403 },
          ),
      ),
    );
    expect(
      await rejectionOf(
        createJinaFetcher({ apiKey: undefined }).fetch({
          url: "https://example.com/page",
          maxChars: 5,
          signal: new AbortController().signal,
        }),
      ),
    ).toMatchObject({ provider: "jina", status: 403 });
    expect(cancelled).toBe(true);
  });

  test("Jina returns its HTTP refusal without waiting for cancellation to finish", async () => {
    const cancellation = deferred<undefined>();
    testFetch.set(
      asFetchMock(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => cancellation.promise,
            }),
            { status: 403 },
          ),
      ),
    );
    try {
      expect(
        await settledWithin(
          rejectionOf(
            createJinaFetcher({ apiKey: undefined }).fetch({
              url: "https://example.com/page",
              maxChars: 5,
              signal: new AbortController().signal,
            }),
          ),
          {
            description: "Jina HTTP refusal independent of cleanup settlement",
            timeoutMs: HAPPY_PATH_TIMEOUT_MS,
          },
        ),
      ).toMatchObject({ provider: "jina", status: 403 });
    } finally {
      cancellation.resolve(undefined);
    }
  });

  describe.each(["jina", "tavily"] as const)(
    "%s key validation",
    (provider) => {
      test.each([200, 401])(
        "status %s decides the outcome despite body cleanup failure",
        async (status) => {
          let cancelled = false;
          testFetch.set(
            asFetchMock(
              async () =>
                new Response(
                  new ReadableStream<Uint8Array>({
                    cancel() {
                      cancelled = true;
                      throw new DOMException("Cleanup failed", "NetworkError");
                    },
                  }),
                  { status },
                ),
            ),
          );
          const result = validateKey[provider]("provider-key");
          if (status === 200) {
            await result;
          } else {
            expect(await rejectionOf(result)).toMatchObject({
              provider,
              status,
            });
          }
          expect(cancelled).toBe(true);
        },
      );

      test.each([200, 401])(
        "status %s does not wait for cancellation to finish",
        async (status) => {
          const cancellation = deferred<undefined>();
          let cancelled = false;
          testFetch.set(
            asFetchMock(
              async () =>
                new Response(
                  new ReadableStream<Uint8Array>({
                    cancel() {
                      cancelled = true;
                      return cancellation.promise;
                    },
                  }),
                  { status },
                ),
            ),
          );
          try {
            const result = validateKey[provider]("provider-key");
            const outcome = await settledWithin(
              status === 200 ? result : rejectionOf(result),
              {
                description:
                  "provider key status independent of cleanup settlement",
                timeoutMs: HAPPY_PATH_TIMEOUT_MS,
              },
            );
            if (status !== 200) {
              expect(outcome).toMatchObject({ provider, status });
            }
            expect(cancelled).toBe(true);
          } finally {
            cancellation.resolve(undefined);
          }
        },
      );

      test("a failed request preserves its original reason", async () => {
        const reason = new DOMException(
          "Provider request cancelled",
          "AbortError",
        );
        testFetch.set(asFetchMock(async () => await Promise.reject(reason)));
        expect(await rejectionOf(validateKey[provider]("provider-key"))).toBe(
          reason,
        );
      });
    },
  );
});
