import { afterEach, expect, test } from "bun:test";

import { BodyByteLimitError } from "@stll/fetch/body-reader";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createTavilyProvider } from "@/api/lib/web-search/tavily";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetch = createTestFetch();
afterEach(() => {
  testFetch.restore();
});
const search = async (signal = new AbortController().signal) =>
  await createTavilyProvider({ apiKey: "test-key" }).search({
    query: "ordinary query",
    jurisdiction: "global",
    freshness: "any",
    maxResults: 1,
    signal,
  });

test("Tavily decodes split UTF-8 and preserves answer, order and result limit", async () => {
  const payload = {
    answer: "Žluť 😀 جواب",
    results: [
      {
        url: "https://example.com/first",
        title: "První 😀",
        content: "نص Žluť",
        score: 0.9,
        published_date: "2026-11-17",
      },
      { url: "https://example.com/second", title: "Second", content: "other" },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  testFetch.set(
    asFetchMock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) {
                controller.enqueue(Uint8Array.of(byte));
              }
              controller.close();
            },
          }),
        ),
    ),
  );
  expect(await search()).toEqual({
    answer: payload.answer,
    results: [
      {
        id: "tavily-0",
        url: "https://example.com/first",
        title: "První 😀",
        snippet: "نص Žluť",
        source: "example.com",
        score: 0.9,
        publishedAt: "2026-11-17",
      },
    ],
  });
});

test("Tavily refuses a finite valid JSON envelope above the local buffer budget", async () => {
  const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
  let step = 0;
  let cancellationReason: unknown;
  testFetch.set(
    asFetchMock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (step === 0) {
                  controller.enqueue(
                    new TextEncoder().encode('{"results":[],"answer":"'),
                  );
                } else if (step <= 128) {
                  controller.enqueue(chunk);
                } else if (step === 129) {
                  controller.enqueue(new TextEncoder().encode('"}'));
                } else {
                  controller.close();
                }
                step += 1;
              },
              cancel(cause) {
                cancellationReason = cause;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    ),
  );
  const error = await rejectionOf(search());
  expect(error).toBeInstanceOf(BodyByteLimitError);
  expect(error).toMatchObject({ limit: 8 * 1024 * 1024 });
  expect(cancellationReason).toBe(error);
});

test("Tavily preserves caller cancellation while its JSON body is pending", async () => {
  const started = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const reason = new Error("Caller cancelled");
  let cancellationReason: unknown;
  testFetch.set(
    asFetchMock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                started.resolve(undefined);
              },
              cancel(cause) {
                cancellationReason = cause;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    ),
  );
  const pending = search(controller.signal);
  await started.promise;
  controller.abort(reason);
  expect(await rejectionOf(pending)).toBe(reason);
  expect(cancellationReason).toBe(reason);
});

test("Tavily preserves the original body read failure", async () => {
  const reason = new Error("Body read failed");
  testFetch.set(
    asFetchMock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(reason);
            },
          }),
        ),
    ),
  );
  expect(await rejectionOf(search())).toBe(reason);
});
