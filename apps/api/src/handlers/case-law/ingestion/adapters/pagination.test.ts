import { afterEach, describe, expect, test } from "bun:test";

import type {
  EmptyAst,
  IngestionResult,
} from "@/api/handlers/case-law/ingestion/adapter";

import { createPagePaginatedFetch } from "./pagination";
import { mockFetchWithFixtures, saveFixture } from "./test-utils";

const FIXTURE_NAME = "pagination-test.json";

type TestItem = { id: number };
type TestResponse = { results: TestItem[]; total: number };

const makeFixture = (items: TestItem[], total: number) =>
  JSON.stringify({ results: items, total });

const itemToDecision = (item: TestItem): IngestionResult => ({
  caseNumber: `CASE-${item.id}`,
  court: "Test Court",
  country: "TST",
  language: "en",
  metadata: {},
  documentAst: {} as EmptyAst,
  rawHash: `hash-${item.id}`,
});

const createTestFetch = (opts?: {
  pageSize?: number;
  legacyPageSize?: number;
  zeroIndexed?: boolean;
  skipEven?: boolean;
}) => {
  const pageSize = opts?.pageSize ?? 3;

  return createPagePaginatedFetch<TestResponse>({
    adapterKey: "test",
    pageSize,
    legacyPageSize: opts?.legacyPageSize,
    zeroIndexed: opts?.zeroIndexed,

    buildRequest: (page) => ({
      url: `https://example.com/test-api?page=${page}`,
    }),

    parseResponse: async (resp) => (await resp.json()) as TestResponse, // eslint-disable-line typescript-eslint/no-unsafe-type-assertion

    extractItems: (data) => ({
      items: data.results,
      total: data.total,
    }),

    parseItem: async (raw) => {
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const item = raw as TestItem;
      if (opts?.skipEven && item.id % 2 === 0) {
        return null;
      }
      return itemToDecision(item);
    },
  });
};

const mockFetchFromDataset = (
  items: TestItem[],
): { restore: () => void; requestedPages: number[] } => {
  const originalFetch = globalThis.fetch;
  const requestedPages: number[] = [];

  const mockedFetch: typeof fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const parsedUrl = new URL(url);
      const page = Number.parseInt(
        parsedUrl.searchParams.get("page") ?? "",
        10,
      );
      const pageSize = Number.parseInt(
        parsedUrl.searchParams.get("pageSize") ?? "",
        10,
      );

      if (Number.isNaN(page) || Number.isNaN(pageSize)) {
        return new Response("Bad request", { status: 400 });
      }

      requestedPages.push(page);
      const start = page * pageSize;
      const results = items.slice(start, start + pageSize);

      return new Response(makeFixture(results, items.length), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    },
    {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    },
  );

  globalThis.fetch = mockedFetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    requestedPages,
  };
};

describe("createPagePaginatedFetch", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("parses first page and returns next cursor", async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
    }));
    await saveFixture(FIXTURE_NAME, makeFixture(items, 10));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const fetchPage = createTestFetch();
    const result = await fetchPage(null, {});
    expect(result.isOk()).toBe(true);

    const page = result.unwrap();
    expect(page.decisions).toHaveLength(3);
    expect(page.decisions[0]?.caseNumber).toBe("CASE-1");
    expect(page.nextCursor).toBe("offset:3");
  });

  test("parks cursor at current offset when exhausted", async () => {
    await saveFixture(FIXTURE_NAME, makeFixture([{ id: 1 }], 1));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const fetchPage = createTestFetch();
    const result = await fetchPage(null, {});
    const page = result.unwrap();
    expect(page.nextCursor).toBe("offset:1");
  });

  test("parking at current offset avoids re-processing exhausted items", async () => {
    await saveFixture(FIXTURE_NAME, makeFixture([{ id: 1 }], 1));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const fetchPage = createTestFetch({ zeroIndexed: true });
    const result = await fetchPage("offset:21", {});
    const page = result.unwrap();
    expect(page.nextCursor).toBe("offset:22");
  });

  test("steps back when page returns zero results (overshoot)", async () => {
    // If the cursor is past the last valid page (API shrank or
    // manual cursor set), the empty response should step back
    // into the valid range instead of parking at an out-of-range
    // cursor forever.
    await saveFixture(FIXTURE_NAME, makeFixture([], 0));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const fetchPage = createTestFetch({ zeroIndexed: true });
    const result = await fetchPage("10", {});
    const page = result.unwrap();
    expect(page.decisions).toHaveLength(0);
    expect(page.nextCursor).toBe("offset:27");
  });

  test("returns error for invalid cursor", async () => {
    const fetchPage = createTestFetch();
    const result = await fetchPage("not-a-number", {});
    expect(result.isErr()).toBe(true);
  });

  test("supports zero-indexed pages", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: i,
    }));
    await saveFixture(FIXTURE_NAME, makeFixture(items, 20));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const fetchPage = createTestFetch({
      pageSize: 5,
      zeroIndexed: true,
    });

    const result = await fetchPage(null, {});
    const page = result.unwrap();
    expect(page.nextCursor).toBe("offset:5");

    const result0 = await fetchPage("offset:0", {});
    expect(result0.isOk()).toBe(true);
  });

  test("skips items when parseItem returns null", async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await saveFixture(FIXTURE_NAME, makeFixture(items, 3));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const fetchPage = createTestFetch({
      pageSize: 5,
      skipEven: true,
    });

    const result = await fetchPage(null, {});
    const page = result.unwrap();
    expect(page.decisions).toHaveLength(2);
    expect(page.decisions[0]?.caseNumber).toBe("CASE-1");
    expect(page.decisions[1]?.caseNumber).toBe("CASE-3");
    expect(page.nextCursor).toBe("offset:3");
  });

  test("resumes at the next un-fetched item after page size changes", async () => {
    const dataset = Array.from({ length: 160 }, (_, index) => ({
      id: index + 1,
    }));
    const mockedFetch = mockFetchFromDataset(dataset);
    restore = mockedFetch.restore;

    const fetchAtPageSize20 = createPagePaginatedFetch<TestResponse>({
      adapterKey: "test",
      pageSize: 20,
      zeroIndexed: true,
      buildRequest: (page) => ({
        url: `https://example.com/test-api?page=${page}&pageSize=20`,
      }),
      parseResponse: async (resp) => (await resp.json()) as TestResponse, // eslint-disable-line typescript-eslint/no-unsafe-type-assertion
      extractItems: (data) => ({
        items: data.results,
        total: data.total,
      }),
      parseItem: async (raw) => itemToDecision(raw as TestItem), // eslint-disable-line typescript-eslint/no-unsafe-type-assertion
    });

    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const result = await fetchAtPageSize20(cursor, {});
      const page = result.unwrap();
      cursor = page.nextCursor;
    }

    expect(cursor).toBe("offset:60");

    const fetchAtPageSize100 = createPagePaginatedFetch<TestResponse>({
      adapterKey: "test",
      pageSize: 100,
      legacyPageSize: 20,
      zeroIndexed: true,
      buildRequest: (page) => ({
        url: `https://example.com/test-api?page=${page}&pageSize=100`,
      }),
      parseResponse: async (resp) => (await resp.json()) as TestResponse, // eslint-disable-line typescript-eslint/no-unsafe-type-assertion
      extractItems: (data) => ({
        items: data.results,
        total: data.total,
      }),
      parseItem: async (raw) => itemToDecision(raw as TestItem), // eslint-disable-line typescript-eslint/no-unsafe-type-assertion
    });

    const result = await fetchAtPageSize100(cursor, {});
    const page = result.unwrap();

    expect(mockedFetch.requestedPages).toEqual([0, 1, 2, 0]);
    expect(page.decisions).toHaveLength(40);
    expect(page.decisions[0]?.caseNumber).toBe("CASE-61");
    expect(page.decisions.at(-1)?.caseNumber).toBe("CASE-100");
    expect(page.nextCursor).toBe("offset:100");
  });

  test("rewinds cursor to last completed chunk on abort", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    await saveFixture(FIXTURE_NAME, makeFixture(items, 100));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const controller = new AbortController();
    let parseCount = 0;

    const fetchPage = createPagePaginatedFetch<TestResponse>({
      adapterKey: "test",
      pageSize: 10,
      zeroIndexed: true,
      itemConcurrency: 3,
      buildRequest: (page) => ({
        url: `https://example.com/test-api?page=${page}`,
      }),
      parseResponse: async (resp) => (await resp.json()) as TestResponse, // eslint-disable-line typescript-eslint/no-unsafe-type-assertion
      extractItems: (data) => ({
        items: data.results,
        total: data.total,
      }),
      parseItem: async (raw) => {
        parseCount++;
        // Abort partway through the second chunk (item 4 of items 4-6).
        if (parseCount === 4) {
          controller.abort();
        }
        return itemToDecision(raw as TestItem); // eslint-disable-line typescript-eslint/no-unsafe-type-assertion
      },
    });

    const result = await fetchPage(null, {}, controller.signal);
    const page = result.unwrap();

    // First chunk (items 1-3) processes fully, processedThroughIndex=3.
    // Second chunk (items 4-6) aborts mid-flight; results discarded so
    // the next cycle re-fetches and re-processes it.
    expect(page.decisions).toHaveLength(3);
    expect(page.decisions[0]?.caseNumber).toBe("CASE-1");
    expect(page.decisions.at(-1)?.caseNumber).toBe("CASE-3");
    expect(page.nextCursor).toBe("offset:3");
  });
});
