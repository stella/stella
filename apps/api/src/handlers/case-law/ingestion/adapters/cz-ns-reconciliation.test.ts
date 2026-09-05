/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import {
  listingIdentityKey,
  parseListingIdentityKey,
  SOURCE_DOCUMENT_ID_MAX_LENGTH,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  CZ_NS_FIRST_SLICE,
  buildCzNsDecision,
  czNsAdapter,
  czNsListingIdentity,
} from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import type { CzNsListingRow } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const reconciliation = requireReconciliation(czNsAdapter);

// ── Production-shaped fixtures ──────────────────────────────
//
// The universal ids and dockets are the publisher's own, copied from the
// search view: a 32-character uppercase hex id and a docket written the way
// the court writes it, suffix and all.

const UNID = {
  FIRST: "05D11F4FB3ACC585C1258E27004D2F09",
  SECOND: "137FECBC92321C61C1258E27004D2ECB",
  THIRD: "2E70B2C9AF8044CFC1258E27004D2EF8",
  /** The decision that settles two dockets in one anchor, from 2025-09-03. */
  CO_SETTLED: "EB8B51F4C8354470C1258CFA004D3FC3",
} as const;

const DOCKET = {
  FIRST: "30 Cdo 3000/2025",
  SECOND: "29 ICdo 83/2026",
  SUFFIXED: "21 Cdo 288/2026- III.",
  /** Two dockets in one anchor, with the publisher's own separator markup. */
  CO_SETTLED: "22 Cdo 807/2025<br />22 ND 148/2025",
  /** Those two dockets as the single case number the store holds. */
  CO_SETTLED_JOINED: "22 Cdo 807/2025, 22 ND 148/2025",
} as const;

/** The anchor the search view prints for one result row. */
const listingRowHtml = (unid: string, docket: string): string =>
  `<tr><td class="td-short icons"><a href="/Judikatura/judikatura_ns.nsf/WebPrint/${unid}?openDocument"></td>` +
  `<td class="td-short-wrap">Nejvyšší soud</td>` +
  `<td class="td-short"><a class="odk" href="/Judikatura/judikatura_ns.nsf/WebSearch/${unid}?openDocument" >${docket}</a></td>` +
  `<td class="td-short  category ">B  </td>` +
  `<td class="td-shorter"><input type="checkbox" id="ids" name="ids" value="${unid}"></td></tr>`;

type ListingPageOptions = {
  rows: readonly (readonly [unid: string, docket: string])[];
  /** The "z N zobrazovaných" number; omitted for a lone hit, as upstream. */
  shown?: number | undefined;
  /** The "(Podmínce vyhovuje: N )" number, printed only when truncated. */
  matched?: number | undefined;
};

const listingPageHtml = ({
  matched,
  rows,
  shown,
}: ListingPageOptions): string => {
  const header =
    shown === undefined
      ? ""
      : `<h3 size="2">Výsledky 1 - ${rows.length} z ${shown} zobrazovaných dokumentů.${
          matched === undefined ? "" : `  (Podmínce vyhovuje: ${matched} )`
        }</h3>`;
  return (
    `<!DOCTYPE HTML><html><head><title>Vyhledávání - Nejvyšší soud</title></head><body>` +
    `<div class="frame-container list-of-judgments"><div class="main_detail">${header}` +
    `<table>${rows.map(([unid, docket]) => listingRowHtml(unid, docket)).join("")}</table>` +
    `<ul class="pagination"></ul></div></div></body></html>`
  );
};

/** What the publisher answers for a day it published nothing on. */
const EMPTY_LISTING_HTML = `<!DOCTYPE HTML><html><body><div class="frame-container list-of-judgments"><div class="main_detail"><div class="list-intro-heading-actions"><h3 size="2">Nebyly nalezeny žádné výsledky vyhledávání.</h3></div><ul class="pagination">  </ul></div></div></body></html>`;

/** A metadata row of the detail page, in the publisher's own markup. */
const detailRowHtml = (label: string, value: string): string =>
  `<tr valign="top"><td class="left-part" width="17%"><b><font face="Times New Roman">${label}:</font></b></td>` +
  `<td class="right-part" width="83%"><b><font face="Times New Roman">${value}</font></b></td></tr>`;

const DECISION_BODY =
  "Nejvyšší soud rozhodl v senátě složeném z předsedy senátu JUDr. Pavla Horáka, Ph.D., " +
  "ve věci žalobkyně proti žalované o zaplacení částky, vedené u Okresního soudu, " +
  "takto: Dovolání se odmítá. Odůvodnění: Soud prvního stupně rozsudkem zamítl žalobu. " +
  "JUDr. Pavel Horák, Ph.D.\npředseda senátu";

const detailPageHtml = (docket: string): string => {
  const rows = [
    detailRowHtml("Datum rozhodnutí", "28. 5. 2026"),
    detailRowHtml("Spisová značka", docket),
    detailRowHtml("ECLI", "ECLI:CZ:NS:2026:30.CDO.3000.2025.1"),
    detailRowHtml("Typ rozhodnutí", "ROZSUDEK"),
    detailRowHtml("Heslo", "Dovolání"),
    detailRowHtml("Kategorie rozhodnutí", "E"),
  ].join("");
  return `<!DOCTYPE HTML><html><body><table>${rows}</table><font face="Times New Roman">${DECISION_BODY}</font></body></html>`;
};

// ── Fetch mocking ───────────────────────────────────────────

const originalFetch = globalThis.fetch;

type MockOptions = {
  listing?: { body: string; status?: number | undefined } | undefined;
  detailStatus?: number | undefined;
  printStatus?: number | undefined;
};

const requestedUrls: string[] = [];

const mockFetch = ({ detailStatus, listing, printStatus }: MockOptions) => {
  globalThis.fetch = asFetchMock((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requestedUrls.push(url);
    if (url.includes("SearchView")) {
      return Promise.resolve(
        new Response(listing?.body ?? "", {
          status: listing?.status ?? 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
    }
    if (url.includes("/WebPrint/")) {
      return Promise.resolve(
        new Response("", {
          status: printStatus ?? 404,
          headers: { "Content-Type": "text/html" },
        }),
      );
    }
    if (url.includes("/WebSearch/")) {
      return Promise.resolve(
        new Response(detailPageHtml(DOCKET.FIRST), {
          status: detailStatus ?? 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  });
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  requestedUrls.length = 0;
});

/**
 * bun-types declares `.rejects.toBeInstanceOf` as void, so awaiting it trips
 * type-aware lint; capture the rejection explicitly instead.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => null,
    (error: unknown) => error,
  );

const listSlice = async (slice: string, page = 0) =>
  await reconciliation.listSlicePage({ slice, page });

// ── Slice arithmetic ────────────────────────────────────────

describe("cz-ns reconciliation slices", () => {
  beforeAll(() => {
    setSystemTime(new Date("2026-08-11T09:30:00.000Z"));
  });
  afterAll(() => {
    setSystemTime();
  });

  test("a slice is the UTC publication day, and sliceOf names the tip", () => {
    expect(reconciliation.sliceOf(new Date("2026-08-11T23:59:59.999Z"))).toBe(
      "2026-08-11",
    );
    expect(reconciliation.sliceOf(new Date("2026-08-12T00:00:00.000Z"))).toBe(
      "2026-08-12",
    );
  });

  test("stepping forward and back is a round trip, across month and leap-day boundaries", () => {
    for (const slice of [
      "2010-01-01",
      "2019-12-31",
      "2024-02-28",
      "2024-02-29",
      "2026-08-10",
    ]) {
      expect(
        reconciliation.previousSlice(reconciliation.nextSlice(slice) ?? ""),
      ).toBe(slice);
    }
    expect(reconciliation.nextSlice("2024-02-28")).toBe("2024-02-29");
    expect(reconciliation.nextSlice("2023-02-28")).toBe("2023-03-01");
  });

  test("the walk is bounded by the first slice below and today above", () => {
    expect(reconciliation.firstSlice).toBe(CZ_NS_FIRST_SLICE);
    expect(reconciliation.previousSlice(CZ_NS_FIRST_SLICE)).toBeNull();
    expect(reconciliation.previousSlice("2010-01-02")).toBe(CZ_NS_FIRST_SLICE);
    expect(reconciliation.nextSlice("2026-08-11")).toBeNull();
    expect(reconciliation.nextSlice("2026-08-10")).toBe("2026-08-11");
  });

  test("the bulk-load day the publisher cannot list sits below the first slice", () => {
    // 2009-12-31 carries the whole legacy archive under one publication date,
    // far past the window a single search addresses.
    const bulkLoadDay = "2009-12-31";
    expect(bulkLoadDay < reconciliation.firstSlice).toBe(true);
    expect(reconciliation.previousSlice(reconciliation.firstSlice)).toBeNull();
  });

  test("walking forward yields slices in lexicographic order", () => {
    const walked: string[] = [];
    let cursor: string | null = "2026-07-28";
    while (cursor !== null && walked.length < 20) {
      walked.push(cursor);
      cursor = reconciliation.nextSlice(cursor);
    }
    expect(walked).toEqual([...walked].toSorted());
    expect(walked.at(-1)).toBe("2026-08-11");
  });

  test("the tip window is that many slices, newest first", () => {
    const slices = tipWindowSlices(reconciliation, new Date());
    expect(slices).toHaveLength(reconciliation.tipWindowDays);
    expect(slices.at(0)).toBe("2026-08-11");
    expect(slices).toEqual([...slices].toSorted().toReversed());
  });

  test("a slice that is not a UTC calendar day is refused", () => {
    expect(() => reconciliation.nextSlice("2026-08")).toThrow(
      "cz-ns slice is not a UTC calendar day",
    );
    expect(() => reconciliation.previousSlice("2026-02-30")).toThrow(
      "cz-ns slice is not a UTC calendar day",
    );
    expect(() => reconciliation.nextSlice("11.08.2026")).toThrow(
      "cz-ns slice is not a UTC calendar day",
    );
  });
});

// ── Identity ────────────────────────────────────────────────

describe("czNsListingIdentity", () => {
  test("keys on the universal id, never the docket", () => {
    const identity = czNsListingIdentity({
      unid: UNID.FIRST,
      caseNumber: DOCKET.FIRST,
    });
    expect(identity).toEqual({
      type: "document",
      sourceDocumentId: UNID.FIRST,
    });
    expect(listingIdentityKey(identity)).toBe(`document:${UNID.FIRST}`);
  });

  test("a row missing either half is unidentifiable, matching what the crawl drops", () => {
    expect(czNsListingIdentity({ unid: "", caseNumber: DOCKET.FIRST })).toEqual(
      {
        type: "unidentifiable",
      },
    );
    expect(czNsListingIdentity({ unid: UNID.FIRST, caseNumber: "" })).toEqual({
      type: "unidentifiable",
    });
    expect(
      listingIdentityKey(czNsListingIdentity({ unid: "", caseNumber: "" })),
    ).toBeNull();
  });

  test("an id the decision column cannot hold keys nothing", () => {
    // Storing it is impossible, so hunting a row under it would keep the slice
    // short for a document nothing can ever write.
    expect(
      czNsListingIdentity({
        unid: "F".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
        caseNumber: DOCKET.FIRST,
      }),
    ).toEqual({ type: "unidentifiable" });
  });

  test("every keyable identity round-trips through its key", () => {
    for (const unid of [UNID.FIRST, UNID.SECOND, UNID.THIRD]) {
      const identity = czNsListingIdentity({ unid, caseNumber: DOCKET.FIRST });
      const key = listingIdentityKey(identity);
      expect(key).not.toBeNull();
      expect(parseListingIdentityKey(key ?? "")).toEqual(identity);
    }
  });

  test("two documents under one docket are two keys, as the store now is", () => {
    const first = czNsListingIdentity({
      unid: UNID.FIRST,
      caseNumber: DOCKET.FIRST,
    });
    const second = czNsListingIdentity({
      unid: UNID.SECOND,
      caseNumber: DOCKET.FIRST,
    });
    expect(listingIdentityKey(first)).not.toBe(listingIdentityKey(second));
  });
});

// ── listSlicePage ───────────────────────────────────────────

describe("cz-ns listSlicePage", () => {
  test("asks the publisher for exactly that day, in one request of the window", async () => {
    mockFetch({
      listing: {
        body: listingPageHtml({
          rows: [
            [UNID.FIRST, DOCKET.FIRST],
            [UNID.SECOND, DOCKET.SECOND],
          ],
          shown: 2,
        }),
      },
    });

    const listed = await listSlice("2026-07-01");

    expect(listed.totalPages).toBe(1);
    expect(listed.items.map(({ payload }) => payload)).toEqual([
      { unid: UNID.FIRST, caseNumber: DOCKET.FIRST },
      { unid: UNID.SECOND, caseNumber: DOCKET.SECOND },
    ]);
    expect(listed.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: UNID.FIRST },
      { type: "document", sourceDocumentId: UNID.SECOND },
    ]);

    const url = requestedUrls.at(0) ?? "";
    const query = new URL(url).searchParams.get("Query") ?? "";
    expect(query).toBe(
      "[datum_predani_na_web]>=01.07.2026 AND [datum_predani_na_web]<=01.07.2026",
    );
    expect(new URL(url).searchParams.get("Start")).toBe("1");
    expect(new URL(url).searchParams.get("Count")).toBe("900");
    expect(requestedUrls).toHaveLength(1);
  });

  test("asking the same slice twice asks the publisher the same question", async () => {
    mockFetch({
      listing: {
        body: listingPageHtml({ rows: [[UNID.FIRST, DOCKET.FIRST]], shown: 1 }),
      },
    });

    const first = await listSlice("2026-07-01");
    const second = await listSlice("2026-07-01");

    expect(second.items).toEqual(first.items);
    expect(requestedUrls.at(1)).toBe(requestedUrls.at(0));
  });

  test("a payload survives being parked as JSON and read back", async () => {
    mockFetch({
      listing: {
        body: listingPageHtml({
          rows: [[UNID.FIRST, DOCKET.SUFFIXED]],
          shown: 1,
        }),
      },
    });

    const listed = await listSlice("2026-07-01");
    const parked = JSON.stringify(listed.items.at(0)?.payload);
    const replayed: unknown = JSON.parse(parked);
    expect(replayed).toEqual({ unid: UNID.FIRST, caseNumber: DOCKET.SUFFIXED });
  });

  test("an anchor settling two dockets is one row carrying both", async () => {
    // The fault this guards needs markup inside the anchor; without it the
    // row parses either way and the test proves nothing.
    expect(DOCKET.CO_SETTLED).toContain("<br />");

    mockFetch({
      listing: {
        body: listingPageHtml({
          rows: [
            [UNID.FIRST, DOCKET.FIRST],
            [UNID.CO_SETTLED, DOCKET.CO_SETTLED],
          ],
          shown: 2,
        }),
      },
    });

    const listed = await listSlice("2025-09-03");

    expect(listed.items.map(({ payload }) => payload)).toEqual([
      { unid: UNID.FIRST, caseNumber: DOCKET.FIRST },
      { unid: UNID.CO_SETTLED, caseNumber: DOCKET.CO_SETTLED_JOINED },
    ]);
    expect(listed.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: UNID.FIRST },
      { type: "document", sourceDocumentId: UNID.CO_SETTLED },
    ]);
  });

  test("a lone hit, which the publisher states no count for, still lists", async () => {
    mockFetch({
      listing: {
        body: listingPageHtml({ rows: [[UNID.FIRST, DOCKET.FIRST]] }),
      },
    });

    const listed = await listSlice("2026-07-01");
    expect(listed.items).toHaveLength(1);
    expect(listed.totalPages).toBe(1);
  });

  test("the publisher's own words for an empty day are an empty slice", async () => {
    mockFetch({ listing: { body: EMPTY_LISTING_HTML } });

    expect(await listSlice("2026-07-05")).toEqual({ items: [], totalPages: 0 });
  });

  test("a failed request is thrown, never read as an empty day", async () => {
    mockFetch({ listing: { body: "", status: 503 } });

    const error = await rejectionOf(listSlice("2026-07-01"));
    expect(String(error)).toContain("503");
  });

  test("a body stating neither results nor emptiness is thrown", async () => {
    mockFetch({ listing: { body: "<html><body>Údržba</body></html>" } });

    const error = await rejectionOf(listSlice("2026-07-01"));
    expect(String(error)).toContain("neither results nor emptiness");
  });

  test("a day past the window the publisher addresses is refused, not truncated", async () => {
    // What 2009-12-31 answers: 900 rows printed, 50,454 matched.
    const rows = Array.from({ length: 900 }, (_, index) => {
      const suffix = index.toString(16).toUpperCase().padStart(4, "0");
      return [
        `${UNID.FIRST.slice(0, 28)}${suffix}`,
        `30 Cdo ${index}/2009`,
      ] as const;
    });
    mockFetch({
      listing: { body: listingPageHtml({ rows, shown: 900, matched: 50_454 }) },
    });

    const error = await rejectionOf(listSlice("2026-07-01"));
    expect(String(error)).toContain("50454");
  });

  test("a counted size below the rows carried is refused too", async () => {
    // A body contradicting itself: its rows are not the day it counted, and
    // which of the two numbers is wrong is not knowable from here.
    mockFetch({
      listing: {
        body: listingPageHtml({
          rows: [
            [UNID.FIRST, DOCKET.FIRST],
            [UNID.SECOND, DOCKET.SECOND],
          ],
          shown: 2,
          matched: 1,
        }),
      },
    });

    const error = await rejectionOf(listSlice("2026-07-01"));
    expect(String(error)).toContain("counts 1 decisions and carries 2");
  });

  test("a stated count the body does not carry is thrown", async () => {
    mockFetch({
      listing: {
        body: listingPageHtml({
          rows: [[UNID.FIRST, DOCKET.FIRST]],
          shown: 40,
        }),
      },
    });

    const error = await rejectionOf(listSlice("2026-07-01"));
    expect(String(error)).toContain("states 40 decisions and carries 1");
  });

  test("several rows under no stated count are thrown, not read as the day", async () => {
    // The publisher omits the count for a lone hit and only for a lone hit,
    // so this is how a change to the listing markup has to surface.
    mockFetch({
      listing: {
        body: listingPageHtml({
          rows: [
            [UNID.FIRST, DOCKET.FIRST],
            [UNID.SECOND, DOCKET.SECOND],
          ],
        }),
      },
    });

    const error = await rejectionOf(listSlice("2026-07-01"));
    expect(String(error)).toContain("states no decisions and carries 2");
  });

  test("a page the slice does not have is refused", async () => {
    mockFetch({
      listing: {
        body: listingPageHtml({ rows: [[UNID.FIRST, DOCKET.FIRST]], shown: 1 }),
      },
    });

    const error = await rejectionOf(listSlice("2026-07-01", 1));
    expect(String(error)).toContain("slice page out of range");
    expect(requestedUrls).toHaveLength(0);
  });
});

// ── buildDecision ───────────────────────────────────────────

describe("cz-ns buildDecision", () => {
  test("builds one listed row through the adapter's own parse path", async () => {
    mockFetch({ printStatus: 404 });

    const built = await reconciliation.buildDecision({
      unid: UNID.FIRST,
      caseNumber: DOCKET.FIRST,
    });

    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision.caseNumber).toBe(DOCKET.FIRST);
    expect(built.decision.language).toBe("cs");
    expect(built.decision.decisionDate).toBe("2026-05-28");
    expect(built.decision.decisionType).toBe("rozsudek");
    expect(built.decision.sourceUrl).toContain(UNID.FIRST);
  });

  test("a built decision is keyed exactly as its listing item was", async () => {
    mockFetch({ printStatus: 404 });

    const row: CzNsListingRow = { unid: UNID.FIRST, caseNumber: DOCKET.FIRST };
    const built = await reconciliation.buildDecision(row);
    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    // Silent drift here is the whole failure mode: a walk that keys a row one
    // way and a build that stores it another leaves the slice permanently
    // short and re-fetches the same document forever.
    expect(built.decision.sourceDocumentId).toBe(UNID.FIRST);
    expect(
      listingIdentityKey({
        type: "document",
        sourceDocumentId: built.decision.sourceDocumentId ?? "",
      }),
    ).toBe(listingIdentityKey(czNsListingIdentity(row)));
  });

  test("the built decision carries the URL its docket-keyed row was stored under", async () => {
    mockFetch({ printStatus: 404 });

    const built = await reconciliation.buildDecision({
      unid: UNID.FIRST,
      caseNumber: DOCKET.FIRST,
    });
    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    // The hint the pipeline re-keys an existing null-id row by: it must be the
    // URL that row carries, which is the one this build stores as `sourceUrl`.
    expect(built.decision.legacySourceUrls).toEqual([
      built.decision.sourceUrl ?? "",
    ]);
  });

  test("a detail page that does not come back is reported, never written", async () => {
    mockFetch({ detailStatus: 404 });

    expect(
      await reconciliation.buildDecision({
        unid: UNID.FIRST,
        caseNumber: DOCKET.FIRST,
      }),
    ).toEqual({ type: "detail-unavailable" });
  });

  test("the crawl sees the status the reconciliation drops", async () => {
    mockFetch({ detailStatus: 503 });

    expect(
      await buildCzNsDecision({ unid: UNID.FIRST, caseNumber: DOCKET.FIRST }),
    ).toEqual({ type: "detail-unavailable", httpStatus: 503 });
  });

  test("a payload this adapter no longer recognises is unkeyable, unasked", async () => {
    mockFetch({});

    for (const payload of [
      null,
      "05D11F4FB3ACC585C1258E27004D2F09",
      { unid: UNID.FIRST },
      { unid: 7, caseNumber: DOCKET.FIRST },
    ]) {
      expect(await reconciliation.buildDecision(payload)).toEqual({
        type: "unkeyable",
      });
    }
    expect(requestedUrls).toHaveLength(0);
  });

  test("a row naming no document is unkeyable without contacting the publisher", async () => {
    mockFetch({});

    expect(
      await reconciliation.buildDecision({
        unid: "",
        caseNumber: DOCKET.FIRST,
      }),
    ).toEqual({ type: "unkeyable" });
    expect(requestedUrls).toHaveLength(0);
  });
});
