/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
/**
 * What the crawl asks obcan.justice.sk for, given the cursor it persisted.
 *
 * The endpoint numbers pages from one and clamps below it, so an adapter that
 * believes otherwise still gets a plausible answer to every request: the
 * counts add up, the cursors advance, and the walk quietly re-reads its first
 * page every lap while every later page arrives one page behind the offset its
 * cursor names. The stub below therefore clamps exactly as the publisher does
 * — a stub numbered from zero would certify the bug.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const PAGE_SIZE = 100;

/** How far the newest-first walk reaches before returning to the head. */
const LIVE_WINDOW_ITEMS = 5000;

/**
 * Items shaped like the API answers: a two-UUID `guid`, a docket written the
 * way the register writes it, and the deciding court by name.
 */
const listItem = (index: number) => ({
  guid: `${index.toString(16).padStart(8, "0")}-0ea1-4249-be21-67f7c341c1f3:6fbcafd6-00b2-4448-bf87-73c5e64a43f5`,
  spisovaZnacka: `${(index % 30) + 1}C/${index}/2020`,
  identifikacneCislo: `13${String(index).padStart(9, "0")}`,
  sud: { nazov: "Okresný súd Bratislava I", registreGuid: "court-guid" },
  datumVydania: "14.05.2020",
  formaRozhodnutia: "Rozsudok",
});

const CORPUS_SIZE = 6000;

type Endpoint = {
  requestedPages: number[];
  restore: () => void;
};

const mockListEndpoint = (): Endpoint => {
  const originalFetch = globalThis.fetch;
  const requestedPages: number[] = [];

  globalThis.fetch = asFetchMock(
    (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const page = url.searchParams.get("page");
      if (page === null) {
        // A per-decision detail request; the crawl asks for one per item.
        return Promise.resolve(
          new Response(
            JSON.stringify({ ecli: "ECLI:SK:OSBA1:2020:1.C.1.2020" }),
            {
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      const requested = Number.parseInt(page, 10);
      requestedPages.push(requested);
      // Numbered from one, clamped below it: `page=0` answers `page=1`.
      const ascending = url.searchParams.get("sortDirection") === "ASC";
      const start = (Math.max(1, requested) - 1) * PAGE_SIZE;
      const items = Array.from({ length: PAGE_SIZE }, (_, offset) => {
        const position = start + offset;
        return listItem(ascending ? position : CORPUS_SIZE - 1 - position);
      }).slice(0, Math.max(0, Math.min(PAGE_SIZE, CORPUS_SIZE - start)));
      return Promise.resolve(
        new Response(
          JSON.stringify({ rozhodnutieList: items, numFound: CORPUS_SIZE }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    },
  );

  return {
    requestedPages,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const fetchAt = async (cursor: string | null) => {
  const result = await skCourtsAdapter.fetchPage(cursor, {});
  if (result.isErr()) {
    throw result.error;
  }
  return result.unwrap();
};

describe("sk-courts crawl pagination", () => {
  let endpoint: Endpoint | undefined;

  afterEach(() => {
    endpoint?.restore();
    endpoint = undefined;
  });

  test("a cursor's offset names the page that begins at it", async () => {
    endpoint = mockListEndpoint();

    const first = await fetchAt("backfill:0");
    const second = await fetchAt("backfill:100");
    const later = await fetchAt("backfill:1200");

    // The first page of the collection is requested as the publisher's own
    // first page, and every later offset one page further — never the same
    // page twice, which is what the clamped `page=0` produced.
    expect(endpoint.requestedPages).toEqual([1, 2, 13]);
    expect(first.decisions.at(0)?.caseNumber).toBe(listItem(0).spisovaZnacka);
    expect(second.decisions.at(0)?.caseNumber).toBe(
      listItem(100).spisovaZnacka,
    );
    expect(later.decisions.at(0)?.caseNumber).toBe(
      listItem(1200).spisovaZnacka,
    );
  });

  test("cursors keep their grammar and their meaning across the walk", async () => {
    endpoint = mockListEndpoint();

    // An item offset in, an item offset out, under the same walk name: a
    // cursor persisted before this fix still names the item it named then.
    expect((await fetchAt("backfill:0")).nextCursor).toBe("backfill:100");
    expect((await fetchAt("backfill:100")).nextCursor).toBe("backfill:200");
    expect((await fetchAt("live:1200")).nextCursor).toBe("live:1300");
    // A null cursor starts the first walk at its own beginning.
    expect((await fetchAt(null)).nextCursor).toBe("backfill:100");
  });

  test("the live walk covers its whole window before turning back", async () => {
    endpoint = mockListEndpoint();

    const pages: number[] = [];
    const collected: string[] = [];
    let cursor: string | null = "live:0";
    for (let step = 0; step < LIVE_WINDOW_ITEMS / PAGE_SIZE; step += 1) {
      const page = await fetchAt(cursor);
      pages.push(...endpoint.requestedPages.splice(0));
      collected.push(...page.decisions.map(({ caseNumber }) => caseNumber));
      cursor = page.nextCursor;
    }

    // One lap reads the window exactly once: five thousand decisions, not
    // forty-nine pages of them plus the first page over again.
    expect(collected).toHaveLength(LIVE_WINDOW_ITEMS);
    expect(new Set(collected).size).toBe(LIVE_WINDOW_ITEMS);
    expect(collected.at(0)).toBe(listItem(CORPUS_SIZE - 1).spisovaZnacka);
    expect(collected.at(-1)).toBe(
      listItem(CORPUS_SIZE - LIVE_WINDOW_ITEMS).spisovaZnacka,
    );
    expect(pages).toHaveLength(LIVE_WINDOW_ITEMS / PAGE_SIZE);
    expect(pages.at(0)).toBe(1);
    expect(pages.at(-1)).toBe(LIVE_WINDOW_ITEMS / PAGE_SIZE);
    // And then returns to the head, which is where the new decisions are.
    expect(cursor).toBe("live:0");
  }, 120_000);
});
