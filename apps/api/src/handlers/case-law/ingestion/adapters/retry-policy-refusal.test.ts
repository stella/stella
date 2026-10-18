import { Result } from "better-result";
import { afterEach, expect, mock, test } from "bun:test";

import { createPolitePublisherFetch } from "@stll/fetch/publisher";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { withImmediatePublisherSlot } from "./publisher-policy";
import { fetchPublisher } from "./retry";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a refused robots redirect is an adapter fetch failure", async () => {
  let resourceRequests = 0;
  globalThis.fetch = asFetchMock(
    mock(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/robots.txt") {
        return Response.redirect("http://127.0.0.1/robots.txt", 302);
      }
      resourceRequests++;
      return new Response("fixture");
    }),
  );
  const publisherFetch = createPolitePublisherFetch({
    validateTarget: async (url) =>
      url.hostname === "127.0.0.1"
        ? Result.err(new Error("private target"))
        : Result.ok(url),
    fetcher: globalThis.fetch,
  });
  const outcome = await withImmediatePublisherSlot({
    adapterKey: ADAPTER_KEYS.CZ_NS,
    dependencies: {
      redis: () => ({ send: () => 1 }),
      sleep: async () => {},
    },
    operation: async () =>
      await Result.tryPromise({
        try: async () =>
          await fetchPublisher("https://rozhodnuti.nsoud.cz/case", {
            adapterKey: ADAPTER_KEYS.CZ_NS,
            fetchStage: "document",
            timeoutMs: 1000,
            publisherFetch,
          }),
        catch: (error) => error,
      }),
  });
  expect(outcome.status).toBe("completed");
  if (outcome.status !== "completed") {
    expect.unreachable();
  }
  expect(outcome.value.isErr()).toBe(true);
  if (outcome.value.isErr()) {
    const { error } = outcome.value;
    expect(error).toBeInstanceOf(AdapterFetchError);
    if (!(error instanceof AdapterFetchError)) {
      expect.unreachable();
    }
    expect(error.cause).toMatchObject({
      _tag: "publisher_target_refused",
    });
  }
  expect(resourceRequests).toBe(0);
});
