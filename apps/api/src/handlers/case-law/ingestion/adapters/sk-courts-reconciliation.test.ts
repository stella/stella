/**
 * The sk-courts listing reconciliation capability.
 *
 * Four things here are silent when wrong and cheap to pin. Slice arithmetic
 * has to round-trip and order lexicographically, because the ledger orders
 * `(source, slice)` rows by byte comparison and a walk that steps wrong looks
 * like a slow loop rather than a broken one. The listing request has to name
 * the slice's own date and translate the contract's zero-based page onto this
 * endpoint's one-based one, or a walk reads a different day than the row it
 * writes. The identity a listed item maps to has to be the identity the built
 * decision stores, or the walk hunts rows the crawl already wrote. And
 * `detail-unavailable` has to stay distinct from a decision built out of the
 * listing alone: this source states `documentUrl` only in the per-decision
 * record, and the document walk finds its work by that column, so writing the
 * listing half alone makes the identity held and the text unreachable at once.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import type { SkApiItem } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import {
  buildSkCourtsDecision,
  SK_COURTS_FIRST_SLICE,
  SK_COURTS_LANGUAGE,
  skCourtsAdapter,
  skCourtsListingIdentity,
} from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { toUtcDateString } from "@/api/lib/dates";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
  listingIdentityKey,
  parseListingIdentityKey,
} from "@/api/lib/legal-search/ingestion-types";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const { reconciliation } = skCourtsAdapter;
if (reconciliation === undefined) {
  throw new Error("sk-courts must declare a reconciliation capability");
}

const LIST_PATH = "/v1/rozhodnutie";
const SLICE = "2026-06-10";

/**
 * Items shaped the way this publisher answers: its compound `<uuid>:<uuid>`
 * guid, the court's own docket spelling and its `DD.MM.YYYY` dates. A
 * shortened stand-in would let an identity or date rule pass here and fail on
 * live traffic.
 */
const GALANTA_ITEM = {
  guid: "00e46f1f-38a5-4457-86bb-88c8440bae47:5ece2b40-ef98-4f3e-acba-d7071425f39d",
  formaRozhodnutia: "Uznesenie bez odôvodnenia",
  povaha: ["Prvostupňové nenapadnuté opravnými prostriedkami"],
  sud: { registreGuid: "sud_112", nazov: "Okresný súd Galanta" },
  sudca: { registreGuid: "sudca_2151", meno: "JUDr. Andrea Sátorová" },
  identifikacneCislo: "2326201348",
  spisovaZnacka: "32Ps/10/2026",
  datumVydania: "10.06.2026",
} satisfies SkApiItem;

const BARDEJOV_ITEM = {
  guid: "01df3d2d-9876-4506-89f0-c3ef23ce9d85:a9584606-4e65-4fa7-9c21-bea2d4a71ed3",
  formaRozhodnutia: "Rozsudok",
  povaha: ["Prvostupňové nenapadnuté opravnými prostriedkami"],
  sud: { registreGuid: "sud_157", nazov: "Okresný súd Bardejov" },
  sudca: { registreGuid: "sudca_1720", meno: "Mgr. Ivana Hanuščaková" },
  identifikacneCislo: "8225201991",
  spisovaZnacka: "19Pc/3/2025",
  datumVydania: "10.06.2026",
} satisfies SkApiItem;

/** The per-decision record, exactly as the publisher answers it. */
const GALANTA_DETAIL = {
  ...GALANTA_ITEM,
  ecli: "ECLI:SK:OSGA:2026:2326201348.1",
  oblast: ["Rodinné právo"],
  podOblast: ["Opatrovníctvo"],
  odkazovanePredpisy: [
    {
      nazov: "/SK/ZZ/2015/160",
      url: "https://www.slov-lex.sk/pravne-predpisy/SK/ZZ/2015/160",
    },
  ],
  dokument: {
    name: "Uznesenie_bez_odôvodnenia_32Ps-10-2026.pdf",
    fileExtension: "PDF",
    size: 55_892,
    url: "https://obcan.justice.sk/content/public/item/5ece2b40-ef98-4f3e-acba-d7071425f39d",
  },
  updateDate: "12.06.2026",
} as const;

type MockResponse = { body: string; status?: number };

const originalFetch = globalThis.fetch;
const requestedUrls: string[] = [];

/** The list endpoint and the per-decision record share a path prefix. */
const isDetailRequest = (url: string): boolean =>
  new URL(url).pathname.split(LIST_PATH).at(-1) !== "";

const mockJustice = (routes: {
  list?: MockResponse;
  detail?: MockResponse;
}): void => {
  globalThis.fetch = asFetchMock(
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

      const route = isDetailRequest(url) ? routes.detail : routes.list;
      if (route === undefined) {
        return await Promise.resolve(
          new Response("Not found", { status: 404 }),
        );
      }
      return await Promise.resolve(
        new Response(route.body, {
          status: route.status ?? 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  );
};

const listBody = (items: readonly unknown[], numFound: number): string =>
  JSON.stringify({ rozhodnutieList: items, numFound, page: 0, size: 1000 });

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
  setSystemTime();
});

describe("sk-courts slice arithmetic", () => {
  test("a step forward and back returns the same slice", () => {
    for (const slice of [
      SK_COURTS_FIRST_SLICE,
      "1999-12-31",
      "2024-02-28",
      "2024-02-29",
      "2024-12-31",
      SLICE,
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
    let slice: string | null = "2013-06-25";
    const walked: string[] = [];
    while (slice !== null && walked.length < 10) {
      walked.push(slice);
      slice = reconciliation.nextSlice(slice);
    }
    expect(walked).toEqual([...walked].toSorted());
    expect(walked.at(0)).toBe("2013-06-25");
    expect(walked.at(-1)).toBe("2013-07-04");
  });

  test("the tip window is a fixed run of slices, newest first", () => {
    const now = new Date("2026-08-11T09:30:00.000Z");
    const slices = tipWindowSlices(reconciliation, now);

    expect(slices).toHaveLength(reconciliation.tipWindowDays);
    expect(slices.at(0)).toBe("2026-08-11");
    // The publisher fills a decision date in for months after it happens, and
    // a date recorded fully collected is settled for good, so the window has
    // to reach past the point where the date stops growing.
    expect(slices.at(-1)).toBe("2026-03-25");
    expect(slices).toEqual([...slices].toSorted().toReversed());
  });

  test("the walk stops at the publisher's first date and at the tip", () => {
    expect(reconciliation.previousSlice(SK_COURTS_FIRST_SLICE)).toBeNull();
    expect(reconciliation.nextSlice("2999-12-30")).toBeNull();
    expect(reconciliation.nextSlice(SK_COURTS_FIRST_SLICE)).toBe("1965-07-12");
    expect(reconciliation.sliceOf(new Date("2026-06-10T23:59:59.999Z"))).toBe(
      SLICE,
    );
    expect(reconciliation.sliceOf(new Date())).toBe(
      toUtcDateString(new Date()),
    );
  });

  test("a slice that is not a UTC calendar day is refused", () => {
    expect(() => reconciliation.nextSlice("2026-06")).toThrow();
    expect(() => reconciliation.previousSlice("2026-02-30")).toThrow();
    expect(() => reconciliation.nextSlice("10.06.2026")).toThrow();
  });
});

describe("sk-courts listing identity", () => {
  test("keys a listed decision on the publisher's own guid", () => {
    expect(skCourtsListingIdentity(GALANTA_ITEM)).toEqual({
      type: "document",
      sourceDocumentId: GALANTA_ITEM.guid,
    });
    expect(skCourtsListingIdentity(BARDEJOV_ITEM)).toEqual({
      type: "document",
      sourceDocumentId: BARDEJOV_ITEM.guid,
    });
  });

  test("falls back to the docket and the language without a guid", () => {
    const { guid: _guid, ...withoutGuid } = GALANTA_ITEM;

    expect(skCourtsListingIdentity(withoutGuid)).toEqual({
      type: "case-number",
      caseNumber: "32Ps/10/2026",
      language: SK_COURTS_LANGUAGE,
    });
  });

  test("a guid too long for the identity column falls back to the docket", () => {
    // The pipeline refuses to store an id past the column's limit, so keying
    // the listing on one would hunt a row nothing can ever write.
    expect(
      skCourtsListingIdentity({ ...GALANTA_ITEM, guid: "x".repeat(257) }),
    ).toEqual({
      type: "case-number",
      caseNumber: "32Ps/10/2026",
      language: SK_COURTS_LANGUAGE,
    });
  });

  test("an item the crawl would drop is unidentifiable", () => {
    // The crawl keeps neither of these, so a slice that counted them would
    // stay short forever.
    expect(
      skCourtsListingIdentity({ ...GALANTA_ITEM, spisovaZnacka: "" }),
    ).toEqual({ type: "unidentifiable" });
    expect(skCourtsListingIdentity({ ...GALANTA_ITEM, sud: null })).toEqual({
      type: "unidentifiable",
    });
    // A payload no current shape recognises: the crawl drops it at the same
    // validator rather than storing a row from it.
    expect(skCourtsListingIdentity({ guid: 42 })).toEqual({
      type: "unidentifiable",
    });
    expect(skCourtsListingIdentity(null)).toEqual({ type: "unidentifiable" });
  });

  test("every keyable identity round-trips through its stored key", () => {
    const { guid: _guid, ...withoutGuid } = GALANTA_ITEM;
    for (const identity of [
      skCourtsListingIdentity(GALANTA_ITEM),
      skCourtsListingIdentity(withoutGuid),
    ]) {
      const key = listingIdentityKey(identity);
      expect(key).not.toBeNull();
      // The compound guid carries a colon, which is also this key's own
      // separator; the round trip is what proves it survives that.
      expect(key === null ? null : parseListingIdentityKey(key)).toEqual(
        identity,
      );
    }
  });
});

describe("sk-courts listSlicePage", () => {
  test("asks the publisher for exactly the slice's decision date", async () => {
    mockJustice({ list: { body: listBody([GALANTA_ITEM], 2559) } });

    await reconciliation.listSlicePage({ slice: SLICE, page: 2 });

    const requested = new URL(requestedUrls.at(0) ?? "");
    expect(requested.searchParams.get("vydaniaOd")).toBe(SLICE);
    expect(requested.searchParams.get("vydaniaDo")).toBe(SLICE);
    // This endpoint numbers pages from one; the contract numbers them from
    // zero, and asking for page 0 here would re-read the first page.
    expect(requested.searchParams.get("page")).toBe("3");
    expect(requested.searchParams.get("size")).toBe("1000");
    // A guid is unique and never reassigned, so a decision indexed mid-walk
    // pushes later items back rather than displacing one onto a page already
    // read.
    expect(requested.searchParams.get("sortProperty")).toBe("guid");
    expect(requested.searchParams.get("sortDirection")).toBe("ASC");
  });

  test("maps a filtered page to identity-tagged, replayable items", async () => {
    mockJustice({
      list: { body: listBody([GALANTA_ITEM, BARDEJOV_ITEM], 2559) },
    });

    const page = await reconciliation.listSlicePage({ slice: SLICE, page: 0 });

    // 2,559 at 1000 a page is three pages; the endpoint states no page count
    // of its own, only the count of what the filter matched.
    expect(page.totalPages).toBe(3);
    expect(page.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: GALANTA_ITEM.guid },
      { type: "document", sourceDocumentId: BARDEJOV_ITEM.guid },
    ]);
    // The loop parks a payload as JSON and replays it days later, so what a
    // page hands back has to survive that round trip unchanged.
    const serialized = JSON.stringify(page.items.map(({ payload }) => payload));
    expect(JSON.parse(serialized)).toEqual([GALANTA_ITEM, BARDEJOV_ITEM]);
  });

  test("a date the publisher lists nothing for reports no pages", async () => {
    mockJustice({ list: { body: listBody([], 0) } });

    const page = await reconciliation.listSlicePage({
      slice: "1965-07-12",
      page: 0,
    });

    expect(page.items).toEqual([]);
    expect(page.totalPages).toBe(0);
  });

  test("one malformed item does not make the whole date unwalkable", async () => {
    mockJustice({
      list: { body: listBody([GALANTA_ITEM, { guid: 42 }], 2) },
    });

    const page = await reconciliation.listSlicePage({ slice: SLICE, page: 0 });

    // Counted as listed but unkeyable, exactly as the crawl drops it. Refusing
    // the page instead would leave the date permanently unreconcilable.
    expect(page.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: GALANTA_ITEM.guid },
      { type: "unidentifiable" },
    ]);
  });

  test("a payload without a count is refused, not read as an empty date", async () => {
    mockJustice({ list: { body: JSON.stringify({ rozhodnutieList: [] }) } });

    expect(await sliceRejection(SLICE)).toBeInstanceOf(AdapterFetchError);
  });

  test("a count with no item list is refused, not read as an empty date", async () => {
    // The single worst envelope to accept: the date would be recorded holding
    // nothing, and a date recorded empty is settled and never revisited.
    mockJustice({ list: { body: JSON.stringify({ numFound: 800 }) } });
    const absent = await sliceRejection(SLICE);

    mockJustice({
      list: { body: JSON.stringify({ numFound: 800, rozhodnutieList: null }) },
    });
    const nulled = await sliceRejection(SLICE);

    expect(absent).toBeInstanceOf(AdapterFetchError);
    expect(nulled).toBeInstanceOf(AdapterFetchError);
  });

  test("a page the count says is populated cannot come back empty", async () => {
    // 2,559 at 1000 a page means page 1 holds items. Answering it with none is
    // the publisher contradicting its own count, and taking it at face value
    // would write that page's decisions out of the date's ledger row.
    mockJustice({ list: { body: listBody([], 2559) } });

    const rejection = await reconciliation
      .listSlicePage({ slice: SLICE, page: 1 })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toBeInstanceOf(AdapterFetchError);
  });

  test("the page past the last one may be empty", async () => {
    // The same shape is legitimate once the offset is past the count, which is
    // where the walk stops; refusing it would make every slice unwalkable.
    mockJustice({ list: { body: listBody([], 2559) } });

    const page = await reconciliation.listSlicePage({ slice: SLICE, page: 3 });

    expect(page.items).toEqual([]);
    expect(page.totalPages).toBe(3);
  });

  test("an upstream failure is raised rather than reported as an empty date", async () => {
    // A publisher this timeout-prone answers 5xx under load, and a slice
    // recorded empty from one is a slice settled at zero forever.
    mockJustice({ list: { body: "Service Unavailable", status: 503 } });

    expect(await sliceRejection(SLICE)).toBeInstanceOf(AdapterFetchError);
  });
});

describe("sk-courts buildDecision", () => {
  test("builds through the adapter's own detail parse path", async () => {
    mockJustice({ detail: { body: JSON.stringify(GALANTA_DETAIL) } });

    const built = await reconciliation.buildDecision(GALANTA_ITEM);

    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision).toMatchObject({
      caseNumber: "32Ps/10/2026",
      court: "Okresný súd Galanta",
      country: "SVK",
      language: SK_COURTS_LANGUAGE,
      decisionDate: "2026-06-10",
      decisionType: "Uznesenie bez odôvodnenia",
      ecli: "ECLI:SK:OSGA:2026:2326201348.1",
      sourceDocumentId: GALANTA_ITEM.guid,
      // Only the per-decision record states this, and the document walk
      // selects the rows it still owes text by exactly this column.
      documentUrl: GALANTA_DETAIL.dokument.url,
    });
    // The one identity rule: what the walk keyed this item on is what the
    // decision it builds actually stores.
    expect(listingIdentityKey(skCourtsListingIdentity(GALANTA_ITEM))).toBe(
      listingIdentityKey({
        type: "document",
        sourceDocumentId: built.decision.sourceDocumentId ?? "",
      }),
    );
  });

  test("a record nothing came back for is unavailable, never built empty", async () => {
    mockJustice({ detail: { body: "Not found", status: 404 } });

    // The listing item alone carries a docket and a court, so the build path
    // could have produced a decision from it. Doing so would make the identity
    // held with no document URL for the walk that fills its text to find.
    expect(await reconciliation.buildDecision(GALANTA_ITEM)).toEqual({
      type: "detail-unavailable",
    });
  });

  test("a record that is not a decision payload is unavailable", async () => {
    mockJustice({ detail: { body: JSON.stringify({ ecli: 42 }) } });

    expect(await reconciliation.buildDecision(BARDEJOV_ITEM)).toEqual({
      type: "detail-unavailable",
    });
  });

  test("the crawl keeps the row the reconciliation refuses", async () => {
    mockJustice({ detail: { body: "Not found", status: 404 } });

    const built = await buildSkCourtsDecision(GALANTA_ITEM);

    // Same call, opposite disposition: the crawl's cursor moves past this item
    // either way, so it stores the listing observation, while the loop filling
    // gaps must not. The decision has to survive the shared path for that.
    expect(built.type).toBe("detail-unavailable");
    if (built.type !== "detail-unavailable") {
      return;
    }
    expect(built.decision).toMatchObject({
      caseNumber: "32Ps/10/2026",
      sourceDocumentId: GALANTA_ITEM.guid,
    });
    expect(built.decision.documentUrl).toBeUndefined();
  });

  test("a payload no current shape recognises is unkeyable", async () => {
    mockJustice({});

    expect(await reconciliation.buildDecision(GALANTA_ITEM.guid)).toEqual({
      type: "unkeyable",
    });
    expect(await reconciliation.buildDecision(null)).toEqual({
      type: "unkeyable",
    });
    expect(await reconciliation.buildDecision({ guid: 42 })).toEqual({
      type: "unkeyable",
    });
    // A record the validator accepts but the adapter refuses to key: no docket
    // to store it under.
    expect(
      await reconciliation.buildDecision({
        ...GALANTA_ITEM,
        spisovaZnacka: null,
      }),
    ).toEqual({ type: "unkeyable" });
    // Nothing was asked of the publisher for any of these.
    expect(requestedUrls).toEqual([]);
  });
});
