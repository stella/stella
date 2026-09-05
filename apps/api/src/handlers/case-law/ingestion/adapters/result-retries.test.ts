import { afterEach, describe, expect, jest, test } from "bun:test";

import { czRegionalAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { skUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const SK_RETRY_DELAY_MS = 500;
const CZ_RETRY_DELAY_MS = 5000;

const flush = async () => {
  for (let tick = 0; tick < 40; tick++) {
    await Promise.resolve();
  }
};

const skEmptyPage = (): Response =>
  Response.json({ documents: [], numFound: 0 });

const czEmptyPage = (): Response =>
  Response.json({ items: [], totalPages: 1, pageNumber: 0 });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

describe("case-law adapter Result retries", () => {
  test("SK US retries a transient search failure once", async () => {
    jest.useFakeTimers();
    let fetchCalls = 0;
    globalThis.fetch = asFetchMock(async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        throw new TypeError("temporary network failure");
      }
      return skEmptyPage();
    });

    const pagePromise = skUsAdapter.fetchPage("2025:0", {});
    await flush();
    expect(fetchCalls).toBe(1);

    jest.advanceTimersByTime(SK_RETRY_DELAY_MS);
    await flush();

    const result = await pagePromise;
    expect(result.isOk()).toBe(true);
    expect(fetchCalls).toBe(2);
  });

  test("SK US does not retry an authentication failure", async () => {
    let fetchCalls = 0;
    globalThis.fetch = asFetchMock(async () => {
      fetchCalls++;
      return new Response(null, { status: 401 });
    });

    const result = await skUsAdapter.fetchPage("2025:0", {});

    expect(result.isErr()).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  test("SK US does not retry a request timeout", async () => {
    let fetchCalls = 0;
    globalThis.fetch = asFetchMock(async () => {
      fetchCalls++;
      throw new DOMException("request timed out", "TimeoutError");
    });

    const result = await skUsAdapter.fetchPage("2025:0", {});

    expect(result.isErr()).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  test("CZ Regional cancels a pending server-error backoff", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    let fetchCalls = 0;
    let settled = false;
    globalThis.fetch = asFetchMock(async () => {
      fetchCalls++;
      return new Response(null, { status: 503 });
    });

    const pagePromise = czRegionalAdapter.fetchPage(
      "2026-01-01:0",
      {},
      controller.signal,
    );
    void pagePromise.then(() => {
      settled = true;
      return settled;
    });
    await flush();

    expect(fetchCalls).toBe(1);
    expect(settled).toBe(false);

    controller.abort();
    await flush();

    const result = await pagePromise;
    expect(result.isErr()).toBe(true);
    expect(settled).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  test("CZ Regional retries a server failure and preserves the page", async () => {
    jest.useFakeTimers();
    let fetchCalls = 0;
    globalThis.fetch = asFetchMock(async () => {
      fetchCalls++;
      return fetchCalls === 1
        ? new Response(null, { status: 503 })
        : czEmptyPage();
    });

    const pagePromise = czRegionalAdapter.fetchPage("2026-01-01:0", {});
    await flush();
    expect(fetchCalls).toBe(1);

    jest.advanceTimersByTime(CZ_RETRY_DELAY_MS);
    await flush();

    const result = await pagePromise;
    expect(result.isOk()).toBe(true);
    expect(fetchCalls).toBe(2);
    if (result.isOk()) {
      expect(result.value.decisions).toEqual([]);
    }
  });
});
