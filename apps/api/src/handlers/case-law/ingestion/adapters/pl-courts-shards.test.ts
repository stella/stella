/**
 * The date shards the pl-courts crawl walks the SAOS dump in.
 *
 * The shard list is the crawl's map of the collection, and everything that
 * makes it wrong is silent. A gap between two shards hides every judgment
 * whose date falls in it, for as long as the list stands. An overlap re-reads
 * work already done. A shard name that moved with the calendar would rename a
 * persisted cursor's prefix and restart the walk from the beginning. A chain
 * that ends without returning to the recent lane parks the crawl on a shard
 * nothing new is ever filed into.
 *
 * The windows are read back out of the URLs the modes actually build, so what
 * is asserted here is what the publisher would be asked for.
 */

import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import { decodeTraversalCursor } from "@/api/handlers/case-law/ingestion/adapters/pagination";
import {
  PL_COURTS_DUMP_SHARDS,
  PL_COURTS_FIRST_SLICE,
  PL_COURTS_RECENT_LOOKBACK_DAYS,
  plCourtsAdapter,
  plCourtsRecentSince,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const RECENT_MODE = "recent";
const HEAD_SHARD = "before-1986";
const TAIL_SHARD = "after-2030";
const HORIZON_LAST_DAY = "2030-12-31";

const paramsOf = (name: string, page = 0): URLSearchParams => {
  const mode = PL_COURTS_DUMP_SHARDS.find((entry) => entry.name === name);
  if (mode === undefined) {
    throw new Error(`pl-courts declares no walk named ${name}`);
  }
  return new URL(mode.buildRequest(page).url).searchParams;
};

/**
 * The judgment-date window a shard asks for. ISO dates order
 * lexicographically, so containment is a string comparison and a null bound
 * is an open side.
 */
type ShardWindow = {
  name: string;
  from: string | null;
  to: string | null;
};

const dateShards: ShardWindow[] = PL_COURTS_DUMP_SHARDS.filter(
  (mode) => mode.name !== RECENT_MODE,
).map((mode) => {
  const params = new URL(mode.buildRequest(0).url).searchParams;
  return {
    name: mode.name,
    from: params.get("judgmentStartDate"),
    to: params.get("judgmentEndDate"),
  };
});

const covers = (shard: ShardWindow, day: string): boolean =>
  (shard.from === null || shard.from <= day) &&
  (shard.to === null || day <= shard.to);

describe("the dump's date shards partition the calendar", () => {
  const firstDay = Temporal.PlainDate.from(PL_COURTS_FIRST_SLICE);
  const lastDay = Temporal.PlainDate.from(HORIZON_LAST_DAY);
  const spanDays = firstDay.until(lastDay).total({ unit: "day" });

  test("INVARIANT: every date the corpus covers is asked for exactly once", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: spanDays }), (dayOffset) => {
        const day = firstDay.add({ days: dayOffset }).toString();
        const matching = dateShards.filter((shard) => covers(shard, day));
        expect(matching.map((shard) => shard.name)).toHaveLength(1);
      }),
      propertyConfig({ numRuns: 1000 }),
    );
  });

  /**
   * Contiguity extends the property above past the dates the corpus should
   * hold: with both ends open and no seam anywhere, a record carrying a
   * mangled year lands in a shard rather than in none.
   */
  test("each shard resumes the day the one before it ends", () => {
    for (const [index, shard] of dateShards.slice(1).entries()) {
      const previous = dateShards[index];
      const end = previous?.to;
      if (end === undefined || end === null) {
        throw new Error(
          `shard ${previous?.name ?? index} leaves its end open mid-list`,
        );
      }
      expect({ shard: shard.name, from: shard.from }).toEqual({
        shard: shard.name,
        from: Temporal.PlainDate.from(end).add({ days: 1 }).toString(),
      });
    }
  });

  test("the catch-alls are the only open-ended shards", () => {
    expect(
      dateShards.filter((shard) => shard.from === null).map(({ name }) => name),
    ).toEqual([HEAD_SHARD]);
    expect(
      dateShards.filter((shard) => shard.to === null).map(({ name }) => name),
    ).toEqual([TAIL_SHARD]);
    expect(dateShards.at(0)?.name).toBe(HEAD_SHARD);
    expect(dateShards.at(-1)?.name).toBe(TAIL_SHARD);
  });

  test("no two walks share a name", () => {
    const names = PL_COURTS_DUMP_SHARDS.map((mode) => mode.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * A cursor is `<walk>:<offset>` split on the first colon, so a name
   * carrying one decodes as some other walk — in practice as none, which
   * restarts the crawl at the first shard on every step.
   */
  test("no name collides with the cursor separator", () => {
    expect(
      PL_COURTS_DUMP_SHARDS.map((mode) => mode.name).filter((name) =>
        name.includes(":"),
      ),
    ).toEqual([]);
  });
});

describe("what each walk asks the dump for", () => {
  test("a yearly shard bounds the whole calendar year", () => {
    expect(Object.fromEntries(paramsOf("y-1995", 7))).toEqual({
      pageSize: "100",
      pageNumber: "7",
      withGenerated: "true",
      judgmentStartDate: "1995-01-01",
      judgmentEndDate: "1995-12-31",
    });
  });

  test("a monthly shard ends on the month's own last day", () => {
    expect(Object.fromEntries(paramsOf("m-2014-03"))).toEqual({
      pageSize: "100",
      pageNumber: "0",
      withGenerated: "true",
      judgmentStartDate: "2014-03-01",
      judgmentEndDate: "2014-03-31",
    });
    // Month length is the calendar's answer, not the year's shape.
    expect(paramsOf("m-2012-02").get("judgmentEndDate")).toBe("2012-02-29");
    expect(paramsOf("m-2013-02").get("judgmentEndDate")).toBe("2013-02-28");
  });

  test("the head catch-all bounds only the end of its window", () => {
    const params = paramsOf(HEAD_SHARD);
    expect(params.get("judgmentStartDate")).toBeNull();
    expect(params.get("judgmentEndDate")).toBe(
      Temporal.PlainDate.from(PL_COURTS_FIRST_SLICE)
        .subtract({ days: 1 })
        .toString(),
    );
  });

  test("the tail catch-all bounds only the start of its window", () => {
    const params = paramsOf(TAIL_SHARD);
    expect(params.get("judgmentStartDate")).toBe("2031-01-01");
    expect(params.get("judgmentEndDate")).toBeNull();
  });

  /**
   * The lane the crawl settles into filters on modification rather than
   * judgment date, so a judgment the publisher edited is listed again whatever
   * date it carries.
   */
  test("the recent lane asks for modifications since a fixed lookback", () => {
    expect(PL_COURTS_RECENT_LOOKBACK_DAYS).toBe(45);
    expect(plCourtsRecentSince(Temporal.PlainDate.from("2026-09-10"))).toBe(
      "2026-07-27T00:00:00.000",
    );

    const params = paramsOf(RECENT_MODE, 3);
    expect(params.get("judgmentStartDate")).toBeNull();
    expect(params.get("judgmentEndDate")).toBeNull();
    expect(params.get("pageNumber")).toBe("3");
    expect(params.get("pageSize")).toBe("100");
    expect(params.get("withGenerated")).toBe("true");
    expect(params.get("sinceModificationDate")).toBe(
      plCourtsRecentSince(Temporal.Now.plainDateISO("UTC")),
    );
  });
});

describe("where each walk hands over", () => {
  test("every walk is followed by the next one in the list", () => {
    const names = PL_COURTS_DUMP_SHARDS.map((mode) => mode.name);
    expect(names.at(-1)).toBe(RECENT_MODE);

    expect(
      PL_COURTS_DUMP_SHARDS.map((mode) => ({
        from: mode.name,
        to: mode.followedBy,
      })),
    ).toEqual(
      names.map((name, index) => ({
        from: name,
        to: names[index + 1] ?? RECENT_MODE,
      })),
    );
    expect(PL_COURTS_DUMP_SHARDS.at(-2)?.name).toBe(TAIL_SHARD);
  });

  /**
   * Naming itself is what keeps the crawl at the head: the helper writes
   * `<successor>:0` on handover, so the lane restarts from its own first page
   * every time it runs dry.
   */
  test("the walk ends on the recent lane, which follows itself", () => {
    const last = PL_COURTS_DUMP_SHARDS.at(-1);
    expect(last?.name).toBe(RECENT_MODE);
    expect(last?.followedBy).toBe(RECENT_MODE);
  });
});

/**
 * What a shard walk does with an answer it cannot read.
 *
 * An empty page is how a shard says it is finished, so a payload read as
 * empty is a payload that ends a shard. A malformed answer must therefore
 * not be read as empty: it has to fail the page, which holds the cursor and
 * asks the same shard again next cycle, rather than handing over and leaving
 * the rest of that shard unread until some later sweep.
 */
describe("a dump answer the crawl cannot read", () => {
  const MID_SHARD_CURSOR = "m-2014-03:0";
  let restore: (() => void) | undefined;

  const answerWith = (body: unknown) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchMock(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
      ),
    );
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  };

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("a page with no items array fails instead of ending the shard", async () => {
    answerWith({ queryTemplate: {} });

    const result = await plCourtsAdapter.fetchPage(MID_SHARD_CURSOR, {});

    expect(Result.isOk(result)).toBe(false);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error.message).toContain("no items array");
  });

  test("a page that states no judgments does end the shard", async () => {
    answerWith({ items: [] });

    const result = await plCourtsAdapter.fetchPage(MID_SHARD_CURSOR, {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }
    expect(result.value.nextCursor).toBe("m-2014-04:0");
  });
});

/**
 * A cursor persisted before the shards existed named an item offset into the
 * unfiltered dump, which points nowhere in a date-filtered walk. Restarting
 * at the first shard is how a crawl carrying such a cursor recovers.
 */
test("a cursor from the offset walk restarts at the first shard", () => {
  const [firstShard] = PL_COURTS_DUMP_SHARDS;
  if (firstShard === undefined) {
    throw new Error("pl-courts declares no walks");
  }

  expect(
    decodeTraversalCursor("offset:1927900", PL_COURTS_DUMP_SHARDS),
  ).toEqual({ mode: firstShard, offset: 0 });
});
