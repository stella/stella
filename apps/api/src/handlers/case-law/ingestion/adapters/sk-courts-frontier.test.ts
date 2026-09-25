/* oxlint-disable typescript-eslint/promise-function-async -- the fetch stub answers with Promise.resolve, matching the mock's own signature */
/**
 * What the steady-state crawl costs obcan.justice.sk once it is caught up.
 *
 * The lap this replaced re-listed the newest five thousand decisions every
 * cycle — fifty pages, every row already held — so the arithmetic, not the
 * cursor grammar, is what these tests hold onto: a cycle with nothing to
 * collect must spend nothing, and a cycle with a closed day must spend one
 * listing plus one detail per row it takes.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const NOW = new Date("2026-09-17T09:30:00.000Z");
const YESTERDAY = "2026-09-16";
const TWO_DAYS_BACK = "2026-09-15";

const listItem = (index: number) => ({
  guid: `${index.toString(16).padStart(8, "0")}-0ea1-4249-be21-67f7c341c1f3:6fbcafd6-00b2-4448-bf87-73c5e64a43f5`,
  spisovaZnacka: `${(index % 30) + 1}C/${index}/2020`,
  identifikacneCislo: `13${String(index).padStart(9, "0")}`,
  sud: { nazov: "Okresný súd Bratislava I", registreGuid: "court-guid" },
  datumVydania: "16.09.2026",
  formaRozhodnutia: "Rozsudok",
});

type Recorded = { listings: URL[]; details: URL[] };

const stubPublisher = (dayHoldings: Record<string, number>): Recorded => {
  const recorded: Recorded = { listings: [], details: [] };

  globalThis.fetch = asFetchMock((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const page = url.searchParams.get("page");
    if (page === null) {
      recorded.details.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({ ecli: "ECLI:SK:OSBA1:2026:1.C.1.2026" }),
          {
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }

    recorded.listings.push(url);
    const day = url.searchParams.get("vydaniaOd") ?? "";
    const size = Number.parseInt(url.searchParams.get("size") ?? "0", 10);
    const total = dayHoldings[day] ?? 0;
    const start = (Math.max(1, Number.parseInt(page, 10)) - 1) * size;
    const items = Array.from(
      { length: Math.max(0, Math.min(size, total - start)) },
      (_, offset) => listItem(start + offset),
    );
    return Promise.resolve(
      new Response(
        JSON.stringify({ rozhodnutieList: items, numFound: total }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  return recorded;
};

const fetchAt = async (cursor: string | null) => {
  const result = await skCourtsAdapter.fetchPage(cursor, {});
  if (result.isErr()) {
    throw result.error;
  }
  return result.unwrap();
};

describe("the sk-courts steady-state frontier", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setSystemTime(NOW);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
  });

  test("a cycle with no day closed since the last one spends nothing", async () => {
    const recorded = stubPublisher({ [YESTERDAY]: 400 });

    const page = await fetchAt(`frontier:${YESTERDAY}:0`);

    expect(recorded.listings).toHaveLength(0);
    expect(recorded.details).toHaveLength(0);
    expect(page.decisions).toHaveLength(0);
    expect(page.nextCursor).toBe(`frontier:${YESTERDAY}:0`);
  });

  test("a closed day costs one listing and one detail per row", async () => {
    const recorded = stubPublisher({ [YESTERDAY]: 3 });

    const page = await fetchAt(`frontier:${TWO_DAYS_BACK}:0`);

    expect(recorded.listings).toHaveLength(1);
    expect(recorded.listings.at(0)?.searchParams.get("vydaniaOd")).toBe(
      YESTERDAY,
    );
    expect(recorded.listings.at(0)?.searchParams.get("vydaniaDo")).toBe(
      YESTERDAY,
    );
    expect(recorded.details).toHaveLength(3);
    expect(page.decisions).toHaveLength(3);
    // The day is listed to its end, so the frontier stands on it.
    expect(page.nextCursor).toBe(`frontier:${YESTERDAY}:0`);
  });

  test("a day the publisher published nothing on costs one listing", async () => {
    const recorded = stubPublisher({});

    const page = await fetchAt(`frontier:${TWO_DAYS_BACK}:0`);

    expect(recorded.listings).toHaveLength(1);
    expect(recorded.details).toHaveLength(0);
    expect(page.decisions).toHaveLength(0);
    expect(page.nextCursor).toBe(`frontier:${YESTERDAY}:0`);
  });

  test("a day larger than a page is finished before the frontier moves", async () => {
    const recorded = stubPublisher({ [YESTERDAY]: 150 });

    const first = await fetchAt(`frontier:${TWO_DAYS_BACK}:0`);
    expect(first.decisions).toHaveLength(100);
    expect(first.nextCursor).toBe(`frontier:${TWO_DAYS_BACK}:1`);

    const second = await fetchAt(first.nextCursor);
    expect(second.decisions).toHaveLength(50);
    expect(second.nextCursor).toBe(`frontier:${YESTERDAY}:0`);

    expect(
      recorded.listings.map((url) => url.searchParams.get("page")),
    ).toEqual(["1", "2"]);
  });

  test("the lap this replaced hands its cursor over without re-listing", async () => {
    const recorded = stubPublisher({ [YESTERDAY]: 0 });

    const page = await fetchAt("live:4700");

    // Two days back, so the first cycle after the handover still lists
    // yesterday rather than standing still for a day.
    expect(page.nextCursor).toBe(`frontier:${YESTERDAY}:0`);
    expect(recorded.listings).toHaveLength(1);
    expect(recorded.details).toHaveLength(0);
  });
});
