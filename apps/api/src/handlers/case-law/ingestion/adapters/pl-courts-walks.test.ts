/**
 * The walks pl-courts can be asked to make over the SAOS dump.
 *
 * Two things are checked here and nowhere else. What each walk kind asks the
 * publisher for, read back out of the URL the kind actually builds, so the
 * assertion is about the request a crawl would send. And what the adapter
 * does with a walk policy: a configuration is operator input, and every way
 * of getting it wrong is otherwise silent — an unserved kind, a name that
 * collides with the cursor separator, a chain that never returns to a walk
 * where new judgments appear.
 *
 * The policies below are small examples written for the assertion they
 * carry. The corpus a deployment configures is not this file's business.
 */

import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import {
  PL_COURTS_WALK_KIND,
  PL_COURTS_WALK_KINDS,
  plCourtsAdapter,
  plCourtsModifiedSince,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

/** One policy entry naming a kind this adapter serves. */
type WalkEntry = {
  name: string;
  kind: keyof typeof PL_COURTS_WALK_KINDS;
} & Record<string, unknown>;

/**
 * A source's configuration, which is untyped JSON: an entry naming a kind
 * this adapter does not serve is something an operator can write, and one of
 * the cases below.
 */
const policy = (
  ...walks: Readonly<Record<string, unknown>>[]
): Record<string, unknown> => ({ walks });

const dateWindow = (name: string, from?: string, to?: string): WalkEntry => ({
  name,
  kind: PL_COURTS_WALK_KIND.JUDGMENT_DATE,
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
});

/**
 * What a kind asks for, read off the URL it builds. The entry goes through
 * the kind's own validation, so a test policy the adapter would refuse fails
 * here rather than asserting against a request nobody could send.
 */
const paramsOf = (entry: WalkEntry, page = 0): URLSearchParams => {
  const built = PL_COURTS_WALK_KINDS[entry.kind].build(entry);
  if (Result.isError(built)) {
    throw new TypeError(`pl-courts refused the entry: ${built.error}`);
  }
  return new URL(built.value(page).url).searchParams;
};

describe("what each walk kind asks the dump for", () => {
  test("a date window bounds both ends of the judgment date", () => {
    expect(
      Object.fromEntries(
        paramsOf(dateWindow("m-2014-03", "2014-03-01", "2014-03-31"), 7),
      ),
    ).toEqual({
      pageSize: "100",
      pageNumber: "7",
      withGenerated: "true",
      judgmentStartDate: "2014-03-01",
      judgmentEndDate: "2014-03-31",
    });
  });

  /**
   * `judgmentDate` is publisher data and a few records carry impossible
   * years, so a policy that means to reach every record needs open ends.
   */
  test("an omitted bound leaves that side of the window open", () => {
    const head = paramsOf(dateWindow("before-1986", undefined, "1986-05-27"));
    expect(head.get("judgmentStartDate")).toBeNull();
    expect(head.get("judgmentEndDate")).toBe("1986-05-27");

    const tail = paramsOf(dateWindow("after-2030", "2031-01-01"));
    expect(tail.get("judgmentStartDate")).toBe("2031-01-01");
    expect(tail.get("judgmentEndDate")).toBeNull();
  });

  test("a since-modified lane filters on modification, not judgment date", () => {
    const params = paramsOf(
      {
        name: "recent",
        kind: PL_COURTS_WALK_KIND.SINCE_MODIFIED,
        lookbackDays: 45,
      },
      3,
    );
    expect(params.get("judgmentStartDate")).toBeNull();
    expect(params.get("judgmentEndDate")).toBeNull();
    expect(params.get("pageNumber")).toBe("3");
    expect(params.get("sinceModificationDate")).toBe(
      plCourtsModifiedSince(Temporal.Now.plainDateISO("UTC"), 45),
    );
  });

  test("the lookback is counted in whole days from the current one", () => {
    expect(
      plCourtsModifiedSince(Temporal.PlainDate.from("2026-09-10"), 45),
    ).toBe("2026-07-27T00:00:00.000");
  });

  test("the plain walk filters nothing", () => {
    expect(
      Object.fromEntries(
        paramsOf({ name: "all", kind: PL_COURTS_WALK_KIND.WHOLE_DUMP }, 2),
      ),
    ).toEqual({ pageSize: "100", pageNumber: "2", withGenerated: "true" });
  });
});

describe("a policy entry the adapter cannot serve", () => {
  const refusalFor = (entry: WalkEntry): string => {
    const built = PL_COURTS_WALK_KINDS[entry.kind].build(entry);
    if (Result.isOk(built)) {
      throw new Error("the entry was accepted");
    }
    return built.error;
  };

  test("a date window that is not a date is refused", () => {
    expect(refusalFor(dateWindow("m-2014-03", "March 2014"))).toContain("from");
  });

  test("a lane with no lookback is refused", () => {
    expect(
      refusalFor({ name: "recent", kind: PL_COURTS_WALK_KIND.SINCE_MODIFIED }),
    ).toContain("lookbackDays");
  });

  /**
   * A mistyped parameter would otherwise read as an absent one, and the walk
   * would ask the publisher for a window nobody configured.
   */
  test("a parameter the kind does not take is refused, not ignored", () => {
    expect(
      refusalFor({
        name: "m-2014-03",
        kind: PL_COURTS_WALK_KIND.JUDGMENT_DATE,
        form: "2014-03-01",
      }),
    ).toBe("does not take form");
  });
});

// ── The configured walk, end to end ──────────────────────

/** The listing request a page was read from, which every page names. */
const requestedParams = (sourceUrl: string | undefined): URLSearchParams => {
  if (sourceUrl === undefined) {
    throw new Error("the page names no listing request");
  }
  return new URL(sourceUrl).searchParams;
};

const answerWith = (body: unknown): (() => void) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetchMock(
    async () =>
      await Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
      ),
  );
  return () => {
    globalThis.fetch = originalFetch;
  };
};

describe("a configured policy drives the crawl", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  const THREE_WINDOWS_AND_A_LANE = policy(
    dateWindow("before-1986", undefined, "1986-05-27"),
    dateWindow("y-1986", "1986-05-28", "1986-12-31"),
    dateWindow("y-1987", "1987-01-01", "1987-12-31"),
    {
      name: "recent",
      kind: PL_COURTS_WALK_KIND.SINCE_MODIFIED,
      lookbackDays: 45,
    },
  );

  test("a walk that runs dry hands over to the next one in the list", async () => {
    restore = answerWith({ items: [] });

    const result = await plCourtsAdapter.fetchPage(
      "y-1986:0",
      THREE_WINDOWS_AND_A_LANE,
    );

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }
    expect(result.value.nextCursor).toBe("y-1987:0");
  });

  /**
   * The last entry names itself, so the crawl settles on it rather than
   * parking past the end of a list it has finished.
   */
  test("the last walk restarts from its own head", async () => {
    restore = answerWith({ items: [] });

    const result = await plCourtsAdapter.fetchPage(
      "recent:0",
      THREE_WINDOWS_AND_A_LANE,
    );

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }
    expect(result.value.nextCursor).toBe("recent:0");
  });

  test("the page is fetched from the window its cursor names", async () => {
    restore = answerWith({ items: [] });

    const result = await plCourtsAdapter.fetchPage(
      "y-1987:0",
      THREE_WINDOWS_AND_A_LANE,
    );

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }
    const params = requestedParams(result.value.sourceUrl);
    expect(params.get("judgmentStartDate")).toBe("1987-01-01");
    expect(params.get("judgmentEndDate")).toBe("1987-12-31");
  });

  /**
   * A cursor written under one policy names a walk the next one need not
   * declare, and an offset counted inside a date window points nowhere in
   * another. Restarting at the first walk is how such a crawl recovers.
   */
  test("a cursor naming an undeclared walk restarts at the first one", async () => {
    restore = answerWith({ items: [] });

    const result = await plCourtsAdapter.fetchPage(
      "m-2014-03:100",
      THREE_WINDOWS_AND_A_LANE,
    );

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }
    expect(requestedParams(result.value.sourceUrl).get("pageNumber")).toBe("0");
    expect(result.value.nextCursor).toBe("y-1986:0");
  });

  test("a source that configures no walks is crawled the plain way", async () => {
    restore = answerWith({ items: [] });

    const result = await plCourtsAdapter.fetchPage("offset:0", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }
    const params = requestedParams(result.value.sourceUrl);
    expect(params.get("judgmentStartDate")).toBeNull();
    expect(params.get("judgmentEndDate")).toBeNull();
    expect(params.get("sinceModificationDate")).toBeNull();
    expect(result.value.nextCursor).toBe("offset:0");
  });

  test("a policy the adapter cannot serve fails the page and holds the cursor", async () => {
    restore = answerWith({ items: [] });

    const result = await plCourtsAdapter.fetchPage(
      "y-1986:100",
      policy({ name: "y-1986", kind: "by-court" }),
    );

    expect(Result.isOk(result)).toBe(false);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error.message).toContain("does not serve");
    expect(result.error.cursor).toBe("y-1986:100");
  });
});

/**
 * What a walk does with an answer it cannot read.
 *
 * An empty page is how a walk says it is finished, so a payload read as empty
 * is a payload that ends a walk. A malformed answer must therefore not be
 * read as empty: it has to fail the page, which holds the cursor and asks the
 * same walk again next cycle, rather than handing over and leaving the rest
 * of that walk unread until some later sweep.
 */
describe("a dump answer the crawl cannot read", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("a page with no items array fails instead of ending the walk", async () => {
    restore = answerWith({ queryTemplate: {} });

    const result = await plCourtsAdapter.fetchPage("offset:0", {});

    expect(Result.isOk(result)).toBe(false);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error.message).toContain("no items array");
  });
});
