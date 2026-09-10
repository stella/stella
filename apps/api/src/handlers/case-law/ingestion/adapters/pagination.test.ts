import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { asTestRaw, readTestJson } from "@/api/tests/helpers/test-tool-set";

import type { FirstPageNumber } from "./pagination";
import {
  createPagePaginatedFetch,
  decodeOffsetCursor,
  decodeTraversalCursor,
  encodeOffsetCursor,
  encodeTraversalCursor,
} from "./pagination";
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
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  metadata: {},
  documentAst: {},
  rawHash: `hash-${item.id}`,
});

const createTestFetch = (opts?: {
  pageSize?: number;
  legacyPageSize?: number;
  firstPage?: FirstPageNumber;
  skipEven?: boolean;
}) => {
  const pageSize = opts?.pageSize ?? 3;

  return createPagePaginatedFetch<TestResponse>({
    adapterKey: "test",
    pageSize,
    legacyPageSize: opts?.legacyPageSize,
    firstPage: opts?.firstPage ?? 1,

    buildRequest: (page) => ({
      url: `https://example.com/test-api?page=${page}`,
    }),

    parseResponse: async (resp) => await readTestJson<TestResponse>(resp),

    extractItems: (data) => ({
      items: data.results,
      total: data.total,
    }),

    parseItem: async (raw) => {
      const item = asTestRaw<TestItem>(raw);
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
      const url = (() => {
        if (typeof input === "string") {
          return input;
        }
        if (input instanceof URL) {
          return input.href;
        }
        return input.url;
      })();
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

  test("names the listing request the page was read from", async () => {
    await saveFixture(FIXTURE_NAME, makeFixture([{ id: 1 }], 10));
    restore = await mockFetchWithFixtures([
      { pattern: "/test-api", fixture: FIXTURE_NAME },
    ]);

    const page = (await createTestFetch()(null, {})).unwrap();

    // The recorder cites this as a fixture's provenance, so it has to be
    // the request that served the listing rather than a URL rebuilt from
    // the same inputs, which could drift from the one actually issued.
    expect(page.sourceUrl).toBe("https://example.com/test-api?page=1");
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

    const fetchPage = createTestFetch({ firstPage: 0 });
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

    const fetchPage = createTestFetch({ firstPage: 0 });
    const result = await fetchPage("10", {});
    const page = result.unwrap();
    expect(page.decisions).toHaveLength(0);
    expect(page.nextCursor).toBe("offset:27");
  });

  test("returns error for invalid cursor", async () => {
    const fetchPage = createTestFetch();
    for (const cursor of [
      "not-a-number",
      "offset:12garbage",
      "3garbage",
      "offset:1.9",
      "offset: 1",
      "offset:+1",
      "offset:01",
      "offset:9007199254740992",
    ]) {
      const result = await fetchPage(cursor, {});
      expect(result.isErr()).toBe(true);
    }
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
      firstPage: 0,
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
      firstPage: 0,
      buildRequest: (page) => ({
        url: `https://example.com/test-api?page=${page}&pageSize=20`,
      }),
      parseResponse: async (resp) => await readTestJson<TestResponse>(resp),
      extractItems: (data) => ({
        items: data.results,
        total: data.total,
      }),
      parseItem: async (raw) => itemToDecision(asTestRaw<TestItem>(raw)),
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
      firstPage: 0,
      buildRequest: (page) => ({
        url: `https://example.com/test-api?page=${page}&pageSize=100`,
      }),
      parseResponse: async (resp) => await readTestJson<TestResponse>(resp),
      extractItems: (data) => ({
        items: data.results,
        total: data.total,
      }),
      parseItem: async (raw) => itemToDecision(asTestRaw<TestItem>(raw)),
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
      firstPage: 0,
      itemConcurrency: 3,
      buildRequest: (page) => ({
        url: `https://example.com/test-api?page=${page}`,
      }),
      parseResponse: async (resp) => await readTestJson<TestResponse>(resp),
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
        return itemToDecision(asTestRaw<TestItem>(raw));
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

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const mockFailingEndpoint = (
  status: number,
): { restore: () => void; requestedPages: number[] } => {
  const originalFetch = globalThis.fetch;
  const requestedPages: number[] = [];

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(requestUrl(input));
      requestedPages.push(
        Number.parseInt(url.searchParams.get("page") ?? "", 10),
      );
      return await Promise.resolve(new Response("", { status }));
    },
    { preconnect: originalFetch.preconnect.bind(originalFetch) },
  );

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    requestedPages,
  };
};

/**
 * Cursor movement is what a refused page costs, and it is only affordable when
 * the refusal is about that page. These pin which refusals are which, because
 * the two look identical in a single call and differ only over a run of them.
 */
describe("a page the origin never answered does not move the cursor", () => {
  let restore: (() => void) | undefined;
  const realSleep = Bun.sleep;

  beforeEach(() => {
    // Every refused page exhausts its retry budget, and the backoff between
    // attempts is randomized wall-clock time. Nothing here is about waiting.
    Bun.sleep = async () => {
      // no-op
    };
  });

  afterEach(() => {
    Bun.sleep = realSleep;
    restore?.();
    restore = undefined;
  });

  /**
   * Drive the walk the way the pipeline does: a failed page leaves the cursor
   * where it was, so only a successful page supplies the next one.
   */
  const walk = async (
    fetchPage: ReturnType<typeof createTestFetch>,
    from: string,
    cycles: number,
  ): Promise<string | null> => {
    let cursor: string | null = from;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const result = await fetchPage(cursor, {});
      if (result.isOk()) {
        cursor = result.unwrap().nextCursor;
      }
    }
    return cursor;
  };

  test("a bad-gateway outage holds the cursor instead of consuming the collection", async () => {
    // The gateway got nothing from the origin, so this page's items are
    // unknown. Every page answers alike while it is down, so a skip that
    // advanced would walk the whole collection one page per refusal and end
    // far past the tip.
    const endpoint = mockFailingEndpoint(502);
    restore = endpoint.restore;

    const cursor = await walk(
      createTestFetch({ firstPage: 0 }),
      "offset:30",
      3,
    );

    expect(cursor).toBe("offset:30");
    expect(new Set(endpoint.requestedPages)).toEqual(new Set([10]));
  });

  /**
   * The origin answered, so the refusal is about this page and skipping it is
   * what keeps one page from stalling a source. A 504 is the publisher proxy's
   * own read timeout, which the origin earns by being slow on this page — the
   * same event `page_skipped_timeout` skips when our timeout fires first.
   */
  test.each([500, 503, 504])(
    "a %i still skips its own page",
    async (status) => {
      const endpoint = mockFailingEndpoint(status);
      restore = endpoint.restore;

      const cursor = await walk(
        createTestFetch({ firstPage: 0 }),
        "offset:30",
        2,
      );

      expect(cursor).toBe("offset:36");
      expect(endpoint.requestedPages).toContain(11);
    },
  );
});

/**
 * A publisher that numbers pages from one usually clamps below it — asking for
 * page zero answers page one rather than an error — so a walk configured with
 * the wrong origin does not fail, it silently reads one page behind its own
 * cursor. The model here clamps for exactly that reason.
 */
const mockClampedEndpoint = (
  items: TestItem[],
  firstPage: FirstPageNumber,
  pageSize: number,
): { restore: () => void; requestedPages: number[] } => {
  const originalFetch = globalThis.fetch;
  const requestedPages: number[] = [];

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(requestUrl(input));
      const requested = Number.parseInt(url.searchParams.get("page") ?? "", 10);
      requestedPages.push(requested);
      const start = (Math.max(firstPage, requested) - firstPage) * pageSize;
      return await Promise.resolve(
        new Response(
          makeFixture(items.slice(start, start + pageSize), items.length),
          { headers: { "Content-Type": "application/json; charset=utf-8" } },
        ),
      );
    },
    { preconnect: originalFetch.preconnect.bind(originalFetch) },
  );

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    requestedPages,
  };
};

describe("an offset names the same items whatever the publisher numbers from", () => {
  const PAGE_SIZE = 10;
  const dataset = Array.from({ length: 200 }, (_, index) => ({
    id: index + 1,
  }));
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  const firstPages = [0, 1] as const satisfies readonly FirstPageNumber[];

  /** The offset a cursor names is the item the page it fetches begins at. */
  const assertOffsetNamesItsPage = async (
    firstPage: FirstPageNumber,
  ): Promise<void> => {
    const endpoint = mockClampedEndpoint(dataset, firstPage, PAGE_SIZE);
    restore = endpoint.restore;
    const fetchPage = createTestFetch({ pageSize: PAGE_SIZE, firstPage });

    for (const offset of [0, PAGE_SIZE, 3 * PAGE_SIZE, 19 * PAGE_SIZE]) {
      const result = await fetchPage(encodeOffsetCursor(offset), {});
      const page = result.unwrap();
      // The cursor is an item offset, so the first decision it yields is the
      // item at that offset — the property a wrong page origin breaks while
      // every count in the response still adds up.
      expect(page.decisions.at(0)?.caseNumber).toBe(`CASE-${offset + 1}`);
      expect(page.decisions).toHaveLength(PAGE_SIZE);
      expect(page.nextCursor).toBe(encodeOffsetCursor(offset + PAGE_SIZE));
    }

    expect(endpoint.requestedPages).toEqual([
      firstPage,
      firstPage + 1,
      firstPage + 3,
      firstPage + 19,
    ]);
  };

  /** Walking from the start reads every item once and none of them twice. */
  const assertNoPageIsReadTwice = async (
    firstPage: FirstPageNumber,
  ): Promise<void> => {
    const endpoint = mockClampedEndpoint(dataset, firstPage, PAGE_SIZE);
    restore = endpoint.restore;
    const fetchPage = createTestFetch({ pageSize: PAGE_SIZE, firstPage });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 5; step += 1) {
      const result = await fetchPage(cursor, {});
      const page = result.unwrap();
      seen.push(...page.decisions.map(({ caseNumber }) => caseNumber));
      cursor = page.nextCursor;
    }

    // A first page re-read by a clamping publisher shows up here and nowhere
    // else: the counts, the cursors and the page numbers all stay plausible.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.at(0)).toBe("CASE-1");
    expect(seen.at(-1)).toBe(`CASE-${5 * PAGE_SIZE}`);
  };

  for (const firstPage of firstPages) {
    test(`INVARIANT: the page fetched for an offset begins at that offset (firstPage ${firstPage})`, async () => {
      await assertOffsetNamesItsPage(firstPage);
    });

    test(`INVARIANT: no page is read twice while the offset advances (firstPage ${firstPage})`, async () => {
      await assertNoPageIsReadTwice(firstPage);
    });
  }
});

describe("offset cursor codec", () => {
  test("INVARIANT: every encoded safe offset decodes exactly", () => {
    fc.assert(
      fc.property(
        fc.maxSafeInteger().filter((offset) => offset >= 0),
        (offset) => {
          expect(
            decodeOffsetCursor({
              cursor: encodeOffsetCursor(offset),
              firstPage: 1,
              legacyPageSize: 20,
            }),
          ).toBe(offset);
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("INVARIANT: suffixing a canonical cursor with non-digits is rejected", () => {
    fc.assert(
      fc.property(
        fc.maxSafeInteger().filter((offset) => offset >= 0),
        fc.constantFrom("a", ".0", " ", "+", "-", "_"),
        (offset, suffix) => {
          expect(
            decodeOffsetCursor({
              cursor: `${encodeOffsetCursor(offset)}${suffix}`,
              firstPage: 1,
              legacyPageSize: 20,
            }),
          ).toBeNull();
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });
});

describe("traversal modes", () => {
  const modes = [
    {
      name: "backfill",
      buildRequest: () => ({ url: "a" }),
      followedBy: "live",
    },
    { name: "live", buildRequest: () => ({ url: "b" }), followedBy: null },
  ] as const;

  test("a cursor names the walk it belongs to", () => {
    expect(decodeTraversalCursor("backfill:1200", modes)).toEqual({
      mode: modes[0],
      offset: 1200,
    });
    expect(decodeTraversalCursor("live:0", modes)).toEqual({
      mode: modes[1],
      offset: 0,
    });
  });

  test("starts the first walk when there is no cursor", () => {
    expect(decodeTraversalCursor(null, modes)?.mode.name).toBe("backfill");
    expect(decodeTraversalCursor(null, modes)?.offset).toBe(0);
  });

  /**
   * An offset counted newest-first points somewhere unrelated oldest-first,
   * so a cursor from before the walks were declared cannot be carried into
   * one. Restarting the first walk is both safe and what catching up needs.
   */
  test("restarts the first walk for a cursor naming no walk", () => {
    for (const cursor of ["offset:1513900", "15139", "nonsense:4"]) {
      expect(decodeTraversalCursor(cursor, modes)).toEqual({
        mode: modes[0],
        offset: 0,
      });
    }
  });

  test("rejects a walk cursor whose offset is not a number", () => {
    expect(decodeTraversalCursor("backfill:-1", modes)).toBeNull();
    expect(decodeTraversalCursor("backfill:x", modes)).toBeNull();
  });

  test("round-trips", () => {
    expect(
      decodeTraversalCursor(encodeTraversalCursor("live", 42), modes),
    ).toEqual({
      mode: modes[1],
      offset: 42,
    });
  });
});

describe("traversal cursors survive the paths that write them", () => {
  const bounded = [
    {
      name: "backfill",
      buildRequest: () => ({ url: "a" }),
      followedBy: "live",
    },
    {
      name: "live",
      buildRequest: () => ({ url: "b" }),
      followedBy: null,
      windowItems: 200,
    },
  ] as const;

  /**
   * A cursor that names no walk restarts the first one, so any path writing
   * a bare offset while a walk is active would silently discard its
   * progress. This asserts the reading half of that contract.
   */
  test("a bare offset cursor discards traversal progress", () => {
    expect(decodeTraversalCursor("offset:1200", bounded)).toEqual({
      mode: bounded[0],
      offset: 0,
    });
  });

  test("a bounded walk declares where it turns back", () => {
    expect(bounded[1].windowItems).toBe(200);
    expect(bounded[0]).not.toHaveProperty("windowItems");
  });
});
