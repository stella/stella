/**
 * The pl-courts listing reconciliation capability.
 *
 * Three things here are silent when wrong and cheap to pin. Slice arithmetic
 * has to round-trip and order lexicographically, because the ledger orders
 * `(source, slice)` rows by byte comparison and a walk that steps wrong looks
 * like a slow loop rather than a broken one. The identity a listed item maps
 * to has to be the identity the built decision stores, or the walk hunts rows
 * the crawl already wrote. And `detail-unavailable` has to stay distinct from
 * a decision built out of the listing alone: writing the latter would make the
 * identity held and take the document out of every later reconciliation.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { SaosItem } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  PL_COURTS_FIRST_SLICE,
  PL_COURTS_LANGUAGE,
  PL_COURTS_SLICE_PAGE_SIZE,
  plCourtsAdapter,
  plCourtsListingIdentity,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { toUtcDateString } from "@/api/lib/dates";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
  listingIdentityKey,
  parseListingIdentityKey,
} from "@/api/lib/legal-search/ingestion-types";

const reconciliation = requireReconciliation(plCourtsAdapter);

const SEARCH_PATTERN = "/api/search/judgments";
const DETAIL_PATTERN = "/api/judgments/";

/** Real SAOS records: a district-court decision and a Supreme Court judgment. */
const COMMON_COURT_ITEM = {
  id: 130_600,
  href: "https://www.saos.org.pl/api/judgments/130600",
  courtType: "COMMON",
  courtCases: [{ caseNumber: "II Co 433/15" }],
  judgmentType: "DECISION",
  judgmentDate: "2015-03-05",
  division: {
    id: 203,
    name: "II Wydział Cywilny Sekcja Egzekucyjna",
    court: { id: 36, code: "15050505", name: "Sąd Rejonowy w Białymstoku" },
  },
} as const satisfies SaosItem;

const SUPREME_COURT_ITEM = {
  id: 168_472,
  href: "https://www.saos.org.pl/api/judgments/168472",
  courtType: "SUPREME",
  courtCases: [{ caseNumber: "V CSK 293/14" }],
  judgmentType: "SENTENCE",
  judgmentDate: "2015-03-05",
} as const satisfies SaosItem;

const SLICE = "2015-03-05";

type MockRoute = {
  pattern: string;
  body: string;
  status?: number | undefined;
  /** What the publisher labels the body; JSON unless a route says otherwise. */
  contentType?: string | undefined;
};

const originalFetch = globalThis.fetch;
const requestedUrls: string[] = [];

const mockFetchWithBodies = (routes: MockRoute[]) => {
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
      requestedUrls.push(url);

      const match = routes
        .filter((route) => url.includes(route.pattern))
        .toSorted((left, right) => right.pattern.length - left.pattern.length)
        .at(0);

      if (!match) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(match.body, {
        status: match.status ?? 200,
        headers: {
          "Content-Type": match.contentType ?? "application/json;charset=UTF-8",
        },
      });
    },
    { preconnect: originalFetch.preconnect.bind(originalFetch) },
  );

  globalThis.fetch = mockedFetch;
};

const searchBody = (items: readonly SaosItem[], totalResults: number): string =>
  JSON.stringify({ items, info: { totalResults } });

/**
 * bun-types declares `.rejects.toBeInstanceOf` as void, so awaiting it trips
 * type-aware lint; capture the rejection explicitly instead.
 */
const sliceRejection = async (slice: string): Promise<unknown> =>
  await reconciliation.listSlicePage({ slice, page: 0 }).then(
    () => null,
    (error: unknown) => error,
  );

afterEach(() => {
  globalThis.fetch = originalFetch;
  requestedUrls.length = 0;
});

describe("pl-courts slice arithmetic", () => {
  test("a step forward and back returns the same slice", () => {
    for (const slice of [
      PL_COURTS_FIRST_SLICE,
      "1999-12-31",
      "2024-02-28",
      "2024-02-29",
      "2024-12-31",
      "2015-03-05",
    ]) {
      const next = reconciliation.nextSlice(slice);
      expect(next).not.toBeNull();
      expect(next === null ? null : reconciliation.previousSlice(next)).toBe(
        slice,
      );
    }
  });

  test("steps across month, year and leap-day boundaries", () => {
    expect(reconciliation.nextSlice("2024-02-28")).toBe("2024-02-29");
    expect(reconciliation.nextSlice("2024-02-29")).toBe("2024-03-01");
    expect(reconciliation.previousSlice("2024-03-01")).toBe("2024-02-29");
    expect(reconciliation.nextSlice("2023-02-28")).toBe("2023-03-01");
    expect(reconciliation.nextSlice("1999-12-31")).toBe("2000-01-01");
    expect(reconciliation.previousSlice("2000-01-01")).toBe("1999-12-31");
  });

  test("the walk order is the lexicographic order", () => {
    let slice: string | null = "2014-12-28";
    const walked: string[] = [];
    while (slice !== null && walked.length < 10) {
      walked.push(slice);
      slice = reconciliation.nextSlice(slice);
    }
    expect(walked).toEqual([...walked].toSorted());
    expect(walked.at(0)).toBe("2014-12-28");
    expect(walked.at(-1)).toBe("2015-01-06");
  });

  test("the tip window is a fixed run of slices, newest first", () => {
    const now = new Date("2026-08-11T09:30:00.000Z");
    const slices = tipWindowSlices(reconciliation, now);

    expect(slices).toHaveLength(reconciliation.tipWindowDays);
    expect(slices.at(0)).toBe("2026-08-11");
    expect(slices.at(-1)).toBe("2026-07-29");
    expect(slices).toEqual([...slices].toSorted().toReversed());
  });

  test("the walk stops at the feed's first day and at the tip", () => {
    expect(reconciliation.previousSlice(PL_COURTS_FIRST_SLICE)).toBeNull();
    expect(reconciliation.nextSlice("2999-12-30")).toBeNull();
    expect(reconciliation.nextSlice(PL_COURTS_FIRST_SLICE)).toBe("1986-05-29");
    expect(reconciliation.sliceOf(new Date("2015-03-05T23:59:59.999Z"))).toBe(
      SLICE,
    );
    expect(reconciliation.sliceOf(new Date())).toBe(
      toUtcDateString(new Date()),
    );
  });

  test("a slice that is not a UTC calendar day is refused", () => {
    expect(() => reconciliation.nextSlice("2015-03")).toThrow(
      "pl-courts slice is not a UTC calendar day",
    );
    expect(() => reconciliation.previousSlice("2015-02-30")).toThrow(
      "pl-courts slice is not a UTC calendar day",
    );
  });
});

describe("pl-courts listing identity", () => {
  test("keys a listed judgment on the publisher's own id", () => {
    expect(plCourtsListingIdentity(COMMON_COURT_ITEM)).toEqual({
      type: "document",
      sourceDocumentId: "130600",
    });
    expect(plCourtsListingIdentity(SUPREME_COURT_ITEM)).toEqual({
      type: "document",
      sourceDocumentId: "168472",
    });
  });

  test("falls back to the docket and the language without an id", () => {
    expect(
      plCourtsListingIdentity({ courtCases: [{ caseNumber: "V CSK 293/14" }] }),
    ).toEqual({
      type: "case-number",
      caseNumber: "V CSK 293/14",
      language: PL_COURTS_LANGUAGE,
    });
  });

  test("an item with nothing to key on is unidentifiable", () => {
    expect(plCourtsListingIdentity({})).toEqual({ type: "unidentifiable" });
    expect(plCourtsListingIdentity({ courtCases: [] })).toEqual({
      type: "unidentifiable",
    });
    expect(plCourtsListingIdentity({ id: null, judgmentDate: SLICE })).toEqual({
      type: "unidentifiable",
    });
  });

  test("every keyable identity round-trips through its stored key", () => {
    for (const identity of [
      plCourtsListingIdentity(COMMON_COURT_ITEM),
      plCourtsListingIdentity({ courtCases: [{ caseNumber: "V CSK 293/14" }] }),
    ]) {
      const key = listingIdentityKey(identity);
      expect(key).not.toBeNull();
      expect(key === null ? null : parseListingIdentityKey(key)).toEqual(
        identity,
      );
    }
  });
});

describe("pl-courts listSlicePage", () => {
  test("asks the publisher for exactly the slice's judgment date", async () => {
    mockFetchWithBodies([
      {
        pattern: SEARCH_PATTERN,
        body: searchBody([COMMON_COURT_ITEM, SUPREME_COURT_ITEM], 283),
      },
    ]);

    await reconciliation.listSlicePage({ slice: SLICE, page: 2 });

    const requested = new URL(requestedUrls.at(0) ?? "");
    expect(requested.searchParams.get("judgmentDateFrom")).toBe(SLICE);
    expect(requested.searchParams.get("judgmentDateTo")).toBe(SLICE);
    expect(requested.searchParams.get("pageNumber")).toBe("2");
    // Half the crawl's dump page: the date-filtered search is a scan, and at
    // 100 its later pages time out into the publisher's maintenance page.
    expect(requested.searchParams.get("pageSize")).toBe(
      String(PL_COURTS_SLICE_PAGE_SIZE),
    );
    expect(PL_COURTS_SLICE_PAGE_SIZE).toBe(50);
    // Ids are assigned once, so a judgment published mid-walk appends past the
    // last page instead of shifting items onto pages already read.
    expect(requested.searchParams.get("sortingField")).toBe("DATABASE_ID");
    expect(requested.searchParams.get("sortingDirection")).toBe("ASC");
  });

  test("maps a filtered page to identity-tagged, replayable items", async () => {
    mockFetchWithBodies([
      {
        pattern: SEARCH_PATTERN,
        body: searchBody([COMMON_COURT_ITEM, SUPREME_COURT_ITEM], 283),
      },
    ]);

    const page = await reconciliation.listSlicePage({ slice: SLICE, page: 0 });

    // 283 filtered results at 50 a page is six pages; the API states no page
    // count of its own.
    expect(page.totalPages).toBe(6);
    expect(page.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: "130600" },
      { type: "document", sourceDocumentId: "168472" },
    ]);
    // The loop parks a payload as JSON and replays it days later, so what a
    // page hands back has to survive that round trip unchanged.
    const serialized = JSON.stringify(page.items.map(({ payload }) => payload));
    expect(JSON.parse(serialized)).toMatchObject([
      { id: 130_600, courtCases: [{ caseNumber: "II Co 433/15" }] },
      { id: 168_472, courtCases: [{ caseNumber: "V CSK 293/14" }] },
    ]);
  });

  test("a day the publisher lists nothing for reports no pages", async () => {
    mockFetchWithBodies([{ pattern: SEARCH_PATTERN, body: searchBody([], 0) }]);

    const page = await reconciliation.listSlicePage({
      slice: "1986-05-29",
      page: 0,
    });

    expect(page.items).toEqual([]);
    expect(page.totalPages).toBe(0);
  });

  test("a payload without a result total is refused, not read as empty", async () => {
    mockFetchWithBodies([
      { pattern: SEARCH_PATTERN, body: JSON.stringify({ items: [] }) },
    ]);

    expect(await sliceRejection(SLICE)).toBeInstanceOf(AdapterFetchError);
  });

  test("an upstream failure is raised rather than reported as an empty day", async () => {
    mockFetchWithBodies([
      { pattern: SEARCH_PATTERN, body: "boom", status: 503 },
    ]);

    expect(await sliceRejection(SLICE)).toBeInstanceOf(AdapterFetchError);
  });

  test("a page the result total says has judgments must return them", async () => {
    // Both spellings of the same malformed page do the same damage: the walk
    // would record the slice from the identities it saw rather than the ones
    // the publisher counted, leaving it settled with the rows never fetched.
    for (const body of [
      JSON.stringify({ items: [], info: { totalResults: 283 } }),
      JSON.stringify({ info: { totalResults: 283 } }),
    ]) {
      mockFetchWithBodies([{ pattern: SEARCH_PATTERN, body }]);
      // oxlint-disable-next-line no-await-in-loop -- one mocked response at a time; the mock is process-global
      expect(await sliceRejection(SLICE)).toBeInstanceOf(AdapterFetchError);
    }
  });

  test("a page past the stated total is empty rather than a failure", async () => {
    // The last page of a day is genuinely empty when the total divides evenly;
    // only a page the total still covers is a contradiction.
    mockFetchWithBodies([
      {
        pattern: SEARCH_PATTERN,
        body: searchBody([], PL_COURTS_SLICE_PAGE_SIZE * 2),
      },
    ]);

    const page = await reconciliation.listSlicePage({ slice: SLICE, page: 2 });

    expect(page.items).toEqual([]);
    expect(page.totalPages).toBe(2);
  });

  test("pages a day of 149 judgments at the slice listing's own size", async () => {
    // The day that exposed this: 149 judgments, whose second page at 100 the
    // publisher answered with a maintenance page after a minute.
    mockFetchWithBodies([
      { pattern: SEARCH_PATTERN, body: searchBody([COMMON_COURT_ITEM], 149) },
    ]);

    const page = await reconciliation.listSlicePage({
      slice: "2019-05-20",
      page: 0,
    });

    expect(page.totalPages).toBe(3);
  });

  test("an answer that is not JSON is a tagged failure naming its type", async () => {
    // What SAOS serves under load: a 200 carrying its maintenance page. Left
    // to `response.json()` this is a bare SyntaxError, which names neither the
    // adapter nor the slice it held.
    mockFetchWithBodies([
      {
        pattern: SEARCH_PATTERN,
        body: "<html><body><h1>Przerwa techniczna</h1></body></html>",
        contentType: "text/html;charset=UTF-8",
      },
    ]);

    const error = await sliceRejection("2019-05-20");

    expect(error).toBeInstanceOf(AdapterFetchError);
    expect(String(error)).toContain("text/html");
  });

  test("the media type is read whole, not searched for", async () => {
    // Both of these carry the JSON media type as a substring and neither is
    // it, so a `Content-Type` containing it is not a `Content-Type` naming it.
    for (const contentType of [
      "application/jsonp",
      "text/html; note=application/json",
    ]) {
      expect(contentType).toContain("application/json");
      mockFetchWithBodies([
        {
          pattern: SEARCH_PATTERN,
          body: searchBody([COMMON_COURT_ITEM], 1),
          contentType,
        },
      ]);
      // oxlint-disable-next-line no-await-in-loop -- one mocked response at a time; the mock is process-global
      expect(await sliceRejection(SLICE)).toBeInstanceOf(AdapterFetchError);
    }
  });

  test("the JSON media type is read past its parameters", async () => {
    // What SAOS actually labels a listing with; the charset must not make it
    // a different media type.
    mockFetchWithBodies([
      {
        pattern: SEARCH_PATTERN,
        body: searchBody([COMMON_COURT_ITEM], 1),
        contentType: "Application/JSON; charset=utf-8",
      },
    ]);

    const page = await reconciliation.listSlicePage({ slice: SLICE, page: 0 });

    expect(page.items).toHaveLength(1);
  });
});

describe("pl-courts buildDecision", () => {
  test("keeps court reporters as people metadata and projects only docket aliases", async () => {
    const item = {
      ...COMMON_COURT_ITEM,
      courtCases: [
        { caseNumber: "II Co 433/15" },
        { caseNumber: "II Cz 100/15" },
      ],
      courtReporters: ["Ewa Popławska-Kośla", "Jerzy Adam Porowski"],
    } as const satisfies SaosItem;
    mockFetchWithBodies([
      {
        pattern: DETAIL_PATTERN,
        body: JSON.stringify({
          data: {
            ...item,
            textContent: "<p>POSTANOWIENIE z dnia 5 marca 2015 r.</p>",
          },
        }),
      },
    ]);

    const built = await reconciliation.buildDecision(item);

    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision.identifiers).toEqual([
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "II Cz 100/15",
      },
    ]);
    expect(built.decision.metadata["courtReporters"]).toEqual([
      "Ewa Popławska-Kośla",
      "Jerzy Adam Porowski",
    ]);
  });

  test("builds through the adapter's own detail parse path", async () => {
    mockFetchWithBodies([
      {
        pattern: DETAIL_PATTERN,
        body: JSON.stringify({
          data: {
            ...COMMON_COURT_ITEM,
            textContent: "<p>POSTANOWIENIE z dnia 5 marca 2015 r.</p>",
            ecli: "ECLI:PL:SRBIA:2015:II.Co.433.15",
            source: {
              code: "COMMON_COURT",
              judgmentUrl: "https://orzeczenia.bialystok.sr.gov.pl/content/1",
            },
          },
        }),
      },
    ]);

    const built = await reconciliation.buildDecision(COMMON_COURT_ITEM);

    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision).toMatchObject({
      caseNumber: "II Co 433/15",
      country: "POL",
      language: PL_COURTS_LANGUAGE,
      decisionDate: "2015-03-05",
      decisionType: "postanowienie",
      court: "Sąd Rejonowy w Białymstoku",
      sourceDocumentId: "130600",
      sourceUrl: "https://www.saos.org.pl/judgments/130600",
    });
    // The one identity rule: what the walk keyed this item on is what the
    // decision it builds actually stores.
    expect(listingIdentityKey(plCourtsListingIdentity(COMMON_COURT_ITEM))).toBe(
      listingIdentityKey({
        type: "document",
        sourceDocumentId: built.decision.sourceDocumentId ?? "",
      }),
    );
  });

  test("a detail nothing came back for is unavailable, never built empty", async () => {
    mockFetchWithBodies([
      { pattern: DETAIL_PATTERN, body: "Not found", status: 404 },
    ]);

    // The listing item alone carries a docket and a court, so the build path
    // could have produced a decision from it. Doing so would make the identity
    // held with the document still unread.
    expect(await reconciliation.buildDecision(COMMON_COURT_ITEM)).toEqual({
      type: "detail-unavailable",
    });
  });

  test("a detail that is not a judgment payload is unavailable", async () => {
    mockFetchWithBodies([
      { pattern: DETAIL_PATTERN, body: JSON.stringify({ error: "gone" }) },
    ]);

    expect(await reconciliation.buildDecision(SUPREME_COURT_ITEM)).toEqual({
      type: "detail-unavailable",
    });
  });

  test("a payload no current shape recognises is unkeyable", async () => {
    mockFetchWithBodies([]);

    expect(await reconciliation.buildDecision("130600")).toEqual({
      type: "unkeyable",
    });
    expect(await reconciliation.buildDecision(null)).toEqual({
      type: "unkeyable",
    });
    // A record with nothing to key on: no id to fetch a detail for and no
    // docket to fall back to.
    expect(await reconciliation.buildDecision({ judgmentDate: SLICE })).toEqual(
      {
        type: "unkeyable",
      },
    );
  });
});
