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
  zeroIndexed?: boolean;
  skipEven?: boolean;
}) => {
  const pageSize = opts?.pageSize ?? 3;

  return createPagePaginatedFetch<TestResponse>({
    adapterKey: "test",
    pageSize,
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
    expect(page.nextCursor).toBe("2");
  });

  test("parks cursor one page back on last page", async () => {
    await saveFixture(FIXTURE_NAME, makeFixture([{ id: 1 }], 1));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const fetchPage = createTestFetch();
    const result = await fetchPage(null, {});
    const page = result.unwrap();
    // Should park at firstPage (1) instead of null to avoid
    // restarting the full scan.
    expect(page.nextCursor).toBe("1");
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
    expect(page.nextCursor).toBe("1");

    const result0 = await fetchPage("0", {});
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
  });
});
