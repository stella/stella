import { panic, Result } from "better-result";
/* oxlint-disable typescript/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import { isDecisionIdentifier } from "@stll/legal-ast/decision-identifier";

import { caseLawDecisions } from "@/api/db/schema";
import {
  decodeSourceRawEnvelope,
  listingIdentityKey,
  parseListingIdentityKey,
  SOURCE_DOCUMENT_ID_MAX_LENGTH,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildCzNsDecision,
  CZ_NS_FIRST_SLICE,
  czNsAdapter,
  czNsListingIdentity,
} from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import type { CzNsListingRow } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import {
  requireReconciliation,
  throughLedgerJson,
} from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import {
  citationKeyOf,
  decisionIdentifiersFromMetadata,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import {
  listReconciliationSlice,
  SLICE_LISTING_PROOF,
} from "@/api/handlers/case-law/ingestion/slice-listing";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@/api/lib/case-law/decision-text";
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

/**
 * The headnote row, which the page carries for every decision: a spacer image
 * where the court wrote none, and its own words where it did. Unlike the rows
 * above, the value is not a `<font>` run, so it runs to the cell's close.
 */
const legalSentenceRowHtml = (value: string | undefined): string => {
  const cell =
    value === undefined
      ? `<img width="1" height="1" src="/icons/ecblank.gif" border="0" alt="">`
      : `<b>${value}</b>`;
  return (
    `<tr valign="top"><td class="left-part" width="17%"><b><font face="Times New Roman">Právní věta:</font></b></td>` +
    `<td class="right-part" style="text-align: justify;" width="83%">${cell}</td></tr>`
  );
};

/** The annotation row, printed only where the court wrote one. */
const abstractRowHtml = (value: string): string =>
  `<tr valign="top"><td class="left-part" width="17%"><b><font face="Times New Roman">Anotace:</font></b></td>` +
  `<td class="right-part" width="83%"><details><summary></summary><p>${value}</p></details></td></tr>`;

type DetailPageOptions = {
  /** The court's headnote, for a decision it selected for its collection. */
  legalSentence?: string | undefined;
  /** The court's case annotation, printed beside the headnote. */
  abstract?: string | undefined;
};

const detailPageHtml = (
  docket: string,
  { abstract, legalSentence }: DetailPageOptions = {},
): string => {
  const rows = [
    legalSentenceRowHtml(legalSentence),
    // The publisher states the deciding court on every detail page, because
    // it is not always its own.
    detailRowHtml("Soud", "Nejvyšší soud"),
    detailRowHtml("Datum rozhodnutí", "28. 5. 2026"),
    detailRowHtml("Spisová značka", docket),
    detailRowHtml("ECLI", "ECLI:CZ:NS:2026:30.CDO.3000.2025.1"),
    detailRowHtml("Typ rozhodnutí", "ROZSUDEK"),
    detailRowHtml("Heslo", "Dovolání"),
    detailRowHtml("Kategorie rozhodnutí", "E"),
    // The day the court handed the document to the web, which the detail page
    // states and the print page does not.
    detailRowHtml("Zveřejněno na webu", "10. 6. 2026"),
    ...(abstract === undefined ? [] : [abstractRowHtml(abstract)]),
  ].join("");
  return `<!DOCTYPE HTML><html><body><table>${rows}</table><font face="Times New Roman">${DECISION_BODY}</font></body></html>`;
};

// ── Fetch mocking ───────────────────────────────────────────

const originalFetch = globalThis.fetch;

type MockOptions = {
  listing?: { body: string; status?: number | undefined } | undefined;
  detailStatus?: number | undefined;
  printStatus?: number | undefined;
  /** What the detail page's headnote and annotation rows state. */
  summary?: DetailPageOptions | undefined;
};

const requestedUrls: string[] = [];

const mockFetch = ({
  detailStatus,
  listing,
  printStatus,
  summary,
}: MockOptions) => {
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
        new Response(detailPageHtml(DOCKET.FIRST, summary), {
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

/** The identity a row keys on, for a row this adapter keys at all. */
const identityOf = (row: CzNsListingRow) => {
  const identity = czNsListingIdentity(row);
  if (identity === null) {
    throw new TypeError(`Expected ${JSON.stringify(row)} to key`);
  }
  return identity;
};

/** The id a row the publisher lists with no usable id is stored under. */
const quarantinedIdOf = (row: CzNsListingRow): string => {
  const identity = identityOf(row);
  if (identity.type !== "document") {
    throw new TypeError("Expected a document identity");
  }
  return identity.sourceDocumentId;
};

const QUARANTINE_ID_PATTERN = /^cz-ns-quarantine:[0-9a-f]{64}$/u;

describe("czNsListingIdentity", () => {
  test("keys on the universal id, never the docket", () => {
    const identity = identityOf({
      unid: UNID.FIRST,
      caseNumber: DOCKET.FIRST,
    });
    expect(identity).toEqual({
      type: "document",
      sourceDocumentId: UNID.FIRST,
    });
    expect(listingIdentityKey(identity)).toBe(`document:${UNID.FIRST}`);
  });

  test("a row with an id and no docket still keys on its id", () => {
    expect(czNsListingIdentity({ unid: UNID.FIRST, caseNumber: "" })).toEqual({
      type: "document",
      sourceDocumentId: UNID.FIRST,
    });
  });

  test("a row with a docket and no id keys on the quarantine identity of its dockets", () => {
    const id = quarantinedIdOf({ unid: "", caseNumber: DOCKET.FIRST });
    expect(id).toMatch(QUARANTINE_ID_PATTERN);
    expect(listingIdentityKey({ type: "document", sourceDocumentId: id })).toBe(
      `document:${id}`,
    );
    // Another docket is another record.
    expect(quarantinedIdOf({ unid: "", caseNumber: DOCKET.SECOND })).not.toBe(
      id,
    );
  });

  test("an id the decision column cannot hold is quarantined, not keyed on", () => {
    // Storing under it is impossible, and the malformed id is not part of the
    // fingerprint: the row is the same record as the id-less one.
    for (const unid of [
      "F".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      "not-a-universal-id",
    ]) {
      expect(quarantinedIdOf({ unid, caseNumber: DOCKET.FIRST })).toBe(
        quarantinedIdOf({ unid: "", caseNumber: DOCKET.FIRST }),
      );
    }
  });

  test("the quarantine identity survives a re-rendered docket list", () => {
    const id = quarantinedIdOf({
      unid: "",
      caseNumber: "22 Cdo 807/2025",
      additionalCaseNumbers: ["22 ND 148/2025"],
    });
    // The Domino view joins co-settled dockets into one `znacka`, and the
    // publisher reflows whitespace between renderings.
    expect(
      quarantinedIdOf({
        unid: "",
        caseNumber: "22 Cdo 807/2025, 22 ND 148/2025",
      }),
    ).toBe(id);
    expect(
      quarantinedIdOf({
        unid: "",
        caseNumber: " 22  Cdo 807/2025",
        additionalCaseNumbers: ["22 ND\n148/2025 "],
      }),
    ).toBe(id);
  });

  test("a row stating neither an id nor a docket keys on nothing", () => {
    expect(czNsListingIdentity({ unid: "", caseNumber: "" })).toBeNull();
    expect(czNsListingIdentity({ unid: "", caseNumber: "  " })).toBeNull();
  });

  test("every keyable identity round-trips through its key", () => {
    for (const row of [
      { unid: UNID.FIRST, caseNumber: DOCKET.FIRST },
      { unid: UNID.SECOND, caseNumber: DOCKET.FIRST },
      { unid: UNID.THIRD, caseNumber: "" },
      { unid: "", caseNumber: DOCKET.FIRST },
    ]) {
      const identity = identityOf(row);
      expect(parseListingIdentityKey(listingIdentityKey(identity))).toEqual(
        identity,
      );
    }
  });

  test("two documents under one docket are two keys, as the store now is", () => {
    const first = identityOf({
      unid: UNID.FIRST,
      caseNumber: DOCKET.FIRST,
    });
    const second = identityOf({
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
    // Every row states a universal id.
    expect(listed.withoutStableFields).toBeUndefined();

    const url = requestedUrls.at(0) ?? "";
    const query = new URL(url).searchParams.get("Query") ?? "";
    expect(query).toBe(
      "[datum_predani_na_web]>=01.07.2026 AND [datum_predani_na_web]<=01.07.2026",
    );
    expect(new URL(url).searchParams.get("Start")).toBe("1");
    expect(new URL(url).searchParams.get("Count")).toBe("900");
    expect(requestedUrls).toHaveLength(1);
  });

  test("a row whose link names no document is quarantined, not left out of the day", async () => {
    const NO_HREF = "NO-HREF";
    const body = listingPageHtml({
      rows: [
        [UNID.FIRST, DOCKET.FIRST],
        ["not-a-universal-id", DOCKET.SECOND],
        [NO_HREF, DOCKET.SUFFIXED],
        // Neither an id nor a docket: counted, nothing to key.
        ["", ""],
      ],
      shown: 4,
    }).replace(
      `href="/Judikatura/judikatura_ns.nsf/WebSearch/${NO_HREF}?openDocument" `,
      "",
    );
    expect(body).not.toContain(`WebSearch/${NO_HREF}`);
    mockFetch({ listing: { body } });

    // Before, the day's own count refused the whole listing for these rows.
    const listed = await listSlice("2026-07-01");

    expect(listed.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: UNID.FIRST },
      {
        type: "document",
        sourceDocumentId: quarantinedIdOf({
          unid: "",
          caseNumber: DOCKET.SECOND,
        }),
      },
      {
        type: "document",
        sourceDocumentId: quarantinedIdOf({
          unid: "",
          caseNumber: DOCKET.SUFFIXED,
        }),
      },
    ]);
    expect(listed.items.at(1)?.payload).toEqual({
      unid: "",
      caseNumber: DOCKET.SECOND,
    });
    // The keyed row names the quarantine id an id-less listing of it gets.
    expect(listed.items.at(0)?.quarantinePeers).toEqual([
      quarantinedIdOf({ unid: "", caseNumber: DOCKET.FIRST }),
    ]);
    expect(listed.items.at(1)?.quarantinePeers).toBeUndefined();
    expect(listed.withoutStableFields).toBe(1);
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
      {
        unid: UNID.CO_SETTLED,
        caseNumber: "22 Cdo 807/2025",
        additionalCaseNumbers: ["22 ND 148/2025"],
      },
    ]);
    expect(listed.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: UNID.FIRST },
      { type: "document", sourceDocumentId: UNID.CO_SETTLED },
    ]);
  });

  test("preserves every co-settled docket across listing, parked payloads and direct builds", async () => {
    const storageLimits = [
      caseLawDecisions.citationKey.length,
      caseLawDecisions.caseNumber.length,
    ];
    for (const size of [1, 10, 24]) {
      const dockets = Array.from(
        { length: size },
        (_, index) => `30 Cdo ${String(index + 1)}/2025`,
      );
      const joined = dockets.join(", ");
      if (size > 1) {
        const limit = storageLimits.at(size === 10 ? 0 : 1);
        expect(limit).toBeDefined();
        expect(joined.length).toBeGreaterThan(
          limit ?? Number.POSITIVE_INFINITY,
        );
      }
      mockFetch({
        listing: {
          body: listingPageHtml({
            rows: [[UNID.CO_SETTLED, dockets.join("<br />")]],
          }),
        },
      });
      const listed = await listSlice("2026-06-10");
      expect(listed.items).toHaveLength(1);
      const item = listed.items.at(0);
      expect(item?.identity).toEqual({
        type: "document",
        sourceDocumentId: UNID.CO_SETTLED,
      });
      const persistedPayload = JSON.stringify(item?.payload);
      const parked: unknown = JSON.parse(persistedPayload);
      const legacy = { unid: UNID.CO_SETTLED, caseNumber: joined };
      const builds = [
        await reconciliation.buildDecision(parked),
        await reconciliation.buildDecision(legacy),
        await buildCzNsDecision(legacy),
      ];
      for (const built of builds) {
        expect(built.type).toBe("built");
        if (built.type !== "built") {
          continue;
        }
        expect(dockets.at(0)).toBe(built.decision.caseNumber);
        const identifiers = decisionIdentifiersFromMetadata({
          caseNumber: built.decision.caseNumber,
          identifiers: built.decision.identifiers,
          jurisdiction: built.decision.country,
        });
        expect(identifiers.map(({ value }) => value)).toEqual(dockets);
        expect(identifiers.every(isDecisionIdentifier)).toBe(true);
        expect(
          Bun.deepEquals(
            built.decision.metadata["additionalCaseNumbers"] ?? [],
            dockets.slice(1),
          ),
        ).toBe(true);
        expect(built.decision.sourceDocumentId).toBe(UNID.CO_SETTLED);
        expect(built.decision.caseNumber.length).toBeLessThanOrEqual(
          caseLawDecisions.caseNumber.length ?? 0,
        );
        const citationKey =
          citationKeyOf(built.decision.caseNumber) ??
          panic("Synthetic docket must have a citation key");
        expect(citationKey.length).toBeLessThanOrEqual(
          caseLawDecisions.citationKey.length ?? 0,
        );
      }
    }
  });

  test("co-settled docket aliases converge after duplicate delivery and JSON replay", async () => {
    mockFetch({});
    const row = {
      unid: UNID.CO_SETTLED,
      caseNumber: DOCKET.FIRST,
      additionalCaseNumbers: [DOCKET.FIRST, DOCKET.SECOND, DOCKET.SECOND],
    };
    const first = await reconciliation.buildDecision(row);
    const persistedPayload = JSON.stringify(row);
    const replayed: unknown = JSON.parse(persistedPayload);
    const second = await reconciliation.buildDecision(replayed);
    expect(first.type).toBe("built");
    expect(second).toEqual(first);
    if (first.type !== "built") {
      return;
    }
    expect(
      Bun.deepEquals(
        first.decision.identifiers?.map(({ value }) => value),
        [DOCKET.SECOND],
      ),
    ).toBe(true);
    expect(
      Bun.deepEquals(first.decision.metadata["additionalCaseNumbers"], [
        DOCKET.SECOND,
      ]),
    ).toBe(true);
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
    expect(built.decision.caseNumber === DOCKET.FIRST).toBe(true);
    expect(built.decision.language).toBe("cs");
    expect(built.decision.decisionDate).toBe("2026-05-28");
    expect(built.decision.decisionType === "rozsudek").toBe(true);
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
    ).toBe(listingIdentityKey(identityOf(row)));
  });

  test("a keyed row and an id-less row on one docket are reported, never merged", async () => {
    // Two documents of one docket, one listed without its id: the docket
    // fingerprint cannot tell them apart, so the keyed one must not adopt the
    // other's quarantine row.
    mockFetch({
      listing: {
        body: listingPageHtml({
          rows: [
            [UNID.FIRST, DOCKET.FIRST],
            ["", DOCKET.FIRST],
          ],
          shown: 2,
        }),
      },
      printStatus: 404,
    });
    const quarantined = quarantinedIdOf({ unid: "", caseNumber: DOCKET.FIRST });

    const listing = await listReconciliationSlice({
      adapterKey: "cz-ns",
      proof: SLICE_LISTING_PROOF.COUNT,
      listSlicePage: reconciliation.listSlicePage,
      revisionOf: reconciliation.revisionOf,
      slice: "2026-07-01",
      pageDelayMs: 0,
      pageTimeoutMs: 5000,
      sleep: async () => {
        await Promise.resolve();
      },
    });
    if (Result.isError(listing)) {
      throw listing.error;
    }
    expect(
      [...listing.value.keyed.values()].map((item) => item.identity),
    ).toEqual([
      { type: "document", sourceDocumentId: UNID.FIRST },
      { type: "document", sourceDocumentId: quarantined },
    ]);
    expect(listing.value.quarantinePeerCollisions).toEqual([quarantined]);

    const built = await reconciliation.buildDecision({
      unid: UNID.FIRST,
      caseNumber: DOCKET.FIRST,
    });
    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision.sourceDocumentIdRepairAliases).toBeUndefined();
  });

  test("a row listed with an id and no docket is read and stored under its id", async () => {
    mockFetch({ printStatus: 404 });

    const built = await reconciliation.buildDecision({
      unid: UNID.FIRST,
      caseNumber: "",
    });
    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision.sourceDocumentId).toBe(UNID.FIRST);
    expect(built.decision.isListingOnly).toBeUndefined();
    expect<string>(built.decision.caseNumber).toBe(UNID.FIRST);
    expect(built.decision.caseNumberIsPlaceholder).toBe(true);
    expect(built.decision.metadata["listingDocketMissing"]).toBe(true);
    // With no docket there is no quarantine row it could have been kept as.
    expect(built.decision.sourceDocumentIdRepairAliases).toBeUndefined();
    expect(requestedUrls.some((url) => url.includes(UNID.FIRST))).toBe(true);
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

  /** The court's own words, as it writes them under `Právní věta:`. */
  const HEADNOTE =
    "Uloží-li soud rodičům povinnost účastnit se mimosoudního smírčího nebo " +
    "mediačního jednání, jde o rozhodnutí, jímž se upravuje řízení, a proti " +
    "takovému rozhodnutí není odvolání přípustné.";

  /** The court's own annotation, as it writes it under `Anotace:`. */
  const ANNOTATION =
    "Okresní soud uložil rodičům povinnost účastnit se mediačního jednání. " +
    "Krajský soud odvolání matky odmítl jako nepřípustné.";

  /** Crawl one decision whose detail page states these summary rows. */
  const crawledWithSummary = async (summary: DetailPageOptions) => {
    mockFetch({ printStatus: 404, summary });
    const built = await reconciliation.buildDecision({
      unid: UNID.FIRST,
      caseNumber: DOCKET.FIRST,
    });
    if (built.type !== "built") {
      throw new TypeError("Expected the fixture decision to build");
    }
    return built.decision;
  };

  test("the court's headnote and annotation reach the decision text fields", async () => {
    const decision = await crawledWithSummary({
      abstract: ANNOTATION,
      legalSentence: HEADNOTE,
    });

    expect(
      Bun.deepEquals(decision.textFields, {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        abstract: { type: TEXT_FIELD_TYPE.PRESENT, text: ANNOTATION },
        legalSentence: { type: TEXT_FIELD_TYPE.PRESENT, text: HEADNOTE },
      }),
    ).toBe(true);
    expect(decision.metadata).not.toHaveProperty("abstract");
    expect(decision.metadata).not.toHaveProperty("legalSentence");
  });

  test("an annotation and an absent headnote remain distinct", async () => {
    const decision = await crawledWithSummary({ abstract: ANNOTATION });

    expect(
      Bun.deepEquals(decision.textFields, {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        abstract: { type: TEXT_FIELD_TYPE.PRESENT, text: ANNOTATION },
      }),
    ).toBe(true);
    expect(decision.metadata).not.toHaveProperty("abstract");
    expect(decision.metadata).not.toHaveProperty("legalSentence");
  });

  test("the spacer the court prints for a decision it wrote neither for is not a summary", async () => {
    const decision = await crawledWithSummary({});

    // The headnote row is on every page; where the court wrote nothing it
    // holds a one-pixel spacer image, which must not be stored as a sentence.
    expect(
      Bun.deepEquals(
        decision.textFields,
        absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      ),
    ).toBe(true);
    expect(decision.metadata).not.toHaveProperty("abstract");
    expect(decision.metadata).not.toHaveProperty("legalSentence");
  });

  test("a headnote or annotation the court adds later moves the source hash", async () => {
    // Sequentially: each crawl installs its own fetch stub on the global.
    const hashes: string[] = [];
    for (const summary of [
      {},
      { legalSentence: HEADNOTE },
      { abstract: ANNOTATION },
      { abstract: ANNOTATION, legalSentence: HEADNOTE },
      { legalSentence: `${HEADNOTE} Věta druhá.` },
    ] satisfies DetailPageOptions[]) {
      hashes.push((await crawledWithSummary(summary)).rawHash);
    }

    // The refresh check skips a row whose source hash stands still. The court
    // writes both after publishing the decision and edits them later, so a row
    // stored before that has to hash differently once the page states the new
    // text; otherwise the update never lands. The hash covers the whole stored
    // detail page, so a headnote alone and an annotation alone cannot collide.
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("the source hash of a fixed crawl is pinned", async () => {
    const decision = await crawledWithSummary({});

    // Every stored row's hash moved when it became the fingerprint of the
    // stored detail, print and listing parts; that move is what carries the
    // listing part onto rows written before it existed, because the refresh
    // check skips a row whose hash stands still. The value is pinned so the
    // next such move is a decision somebody makes rather than a side effect
    // of editing the parser or the stored envelope.
    expect(decision.rawHash).toBe(
      "f9c98ab4a68ae755d850d04660e583ab737df59473cad7ec09f49c6dadbf9b05",
    );
  });

  test("alias-only publisher changes move the source hash", async () => {
    mockFetch({ printStatus: 404 });
    const hashes: string[] = [];
    for (const additionalCaseNumbers of [
      undefined,
      [DOCKET.SECOND],
      [DOCKET.SECOND, DOCKET.SUFFIXED],
      [DOCKET.SUFFIXED, DOCKET.SECOND],
    ]) {
      const built = await reconciliation.buildDecision({
        unid: UNID.FIRST,
        caseNumber: DOCKET.FIRST,
        additionalCaseNumbers,
      });
      expect(built.type).toBe("built");
      if (built.type === "built") {
        hashes.push(built.decision.rawHash);
      }
    }
    expect(new Set(hashes).size).toBe(4);
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
    ).toEqual({
      type: "detail-unavailable",
      page: "detail",
      read: { type: "unavailable", cause: { kind: "status", status: 503 } },
    });
  });

  test("a payload this adapter no longer recognises is unkeyable, unasked", async () => {
    mockFetch({});

    for (const payload of [
      null,
      "05D11F4FB3ACC585C1258E27004D2F09",
      { unid: UNID.FIRST },
      { unid: 7, caseNumber: DOCKET.FIRST },
      ...[null, "another docket", [7], [""], [" "]].map(
        (additionalCaseNumbers) => ({
          unid: UNID.FIRST,
          caseNumber: DOCKET.FIRST,
          additionalCaseNumbers,
        }),
      ),
    ]) {
      expect(await reconciliation.buildDecision(payload)).toEqual({
        type: "unkeyable",
      });
    }
    expect(requestedUrls).toHaveLength(0);
  });

  test("a row with no usable id is built listing-only under its quarantine identity, unasked", async () => {
    mockFetch({});

    const row: CzNsListingRow = {
      unid: "",
      caseNumber: DOCKET.FIRST,
      additionalCaseNumbers: [DOCKET.SECOND],
    };
    const built = await reconciliation.buildDecision(row);

    // Built, not parked: there is no detail page to wait for.
    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    const { decision } = built;
    expect(decision.sourceDocumentId).toBe(quarantinedIdOf(row));
    expect(decision.sourceDocumentId).toMatch(QUARANTINE_ID_PATTERN);
    expect(decision.isListingOnly).toBe(true);
    expect<string>(decision.caseNumber).toBe(DOCKET.FIRST);
    expect(decision.caseNumberIsPlaceholder).toBeUndefined();
    expect(throughLedgerJson(decision.identifiers)).toEqual([
      { type: "case-number", value: DOCKET.SECOND },
    ]);
    expect(decision.metadata).toMatchObject({
      identityQuarantined: true,
      listedOnly: true,
      listedOnlyReason: "missing-record-identity",
      additionalCaseNumbers: [DOCKET.SECOND],
    });
    expect(decision.sourceDocumentIdRepairAliases).toBeUndefined();
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(JSON.parse(parts?.["listing"] ?? "null")).toEqual(row);
    expect(parts?.["detail"]).toBeUndefined();
    expect(requestedUrls).toHaveLength(0);
  });

  test("an over-long id is quarantined the same way, never requested", async () => {
    mockFetch({});

    const built = await reconciliation.buildDecision({
      unid: "F".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      caseNumber: DOCKET.FIRST,
    });
    expect(built.type === "built" && built.decision.sourceDocumentId).toBe(
      quarantinedIdOf({ unid: "", caseNumber: DOCKET.FIRST }),
    );
    expect(requestedUrls).toHaveLength(0);
  });

  test("a row stating neither an id nor a docket is unkeyable without contacting the publisher", async () => {
    mockFetch({});

    expect(
      await reconciliation.buildDecision({ unid: "", caseNumber: "" }),
    ).toEqual({ type: "unkeyable" });
    expect(requestedUrls).toHaveLength(0);
  });
});

describe("cz-ns stored-raw replay", () => {
  const replay = czNsAdapter.reparseStoredRaw;
  if (replay === undefined) {
    throw new TypeError("Expected cz-ns to implement reparseStoredRaw");
  }

  /** What the decision table hands the replay for a stored row. */
  const storedRowOf = (decision: IngestionResult) => ({
    raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
    contentType: decision.sourceRawContentType ?? null,
    caseNumber: decision.caseNumber,
    sourceDocumentId: decision.sourceDocumentId ?? null,
    language: decision.language,
    court: decision.court,
    ecli: decision.ecli ?? null,
    decisionDate: decision.decisionDate ?? null,
    decisionType: decision.decisionType ?? null,
    sourceUrl: decision.sourceUrl ?? null,
    documentUrl: decision.documentUrl ?? null,
    metadata: decision.metadata,
  });

  // The second row is listed without a docket: its stored docket is the id
  // standing in for one, which the replay must not read back as a docket.
  for (const row of [
    {
      unid: UNID.CO_SETTLED,
      caseNumber: DOCKET.FIRST,
      additionalCaseNumbers: [DOCKET.SECOND],
    },
    { unid: UNID.FIRST, caseNumber: "" },
  ] satisfies CzNsListingRow[]) {
    test(`current envelopes rebuild to a fixed point without the network (${row.caseNumber || "no docket"})`, async () => {
      mockFetch({ printStatus: 404 });
      const built = await reconciliation.buildDecision(row);
      if (built.type !== "built") {
        throw new TypeError("Expected the fixture decision to build");
      }
      globalThis.fetch = asFetchMock(async () => {
        throw new Error("a replay must not contact the publisher");
      });

      const outcome = await replay(storedRowOf(built.decision));

      expect(outcome).toEqual({ type: "parsed", result: built.decision });
    });
  }

  test("a quarantined listing row has no pages to replay", async () => {
    mockFetch({});
    const built = await reconciliation.buildDecision({
      unid: "",
      caseNumber: DOCKET.FIRST,
    });
    if (built.type !== "built") {
      throw new TypeError("Expected the quarantined row to build");
    }

    expect(await replay(storedRowOf(built.decision))).toEqual({
      type: "rejected",
      rejection: "no-document",
      detail: "a quarantined listing row holds no decision pages",
    });
  });

  test("legacy joined dockets recover every identity from the saved pages", async () => {
    globalThis.fetch = asFetchMock(async () => {
      throw new Error("a replay must not contact the publisher");
    });
    const joined = `${DOCKET.FIRST}, ${DOCKET.SECOND}`;
    const outcome = await replay({
      raw: new TextEncoder().encode(
        JSON.stringify({
          webHtml: detailPageHtml(DOCKET.FIRST),
          printHtml: "",
        }),
      ),
      contentType: "text/html",
      caseNumber: joined,
      sourceDocumentId: UNID.CO_SETTLED,
      language: "cs",
      court: "Nejvyšší soud",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: { caseNumber: joined },
    });

    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    expect(outcome.result.caseNumber === DOCKET.FIRST).toBe(true);
    expect(
      Bun.deepEquals(
        outcome.result.identifiers?.map(({ value }) => value),
        [DOCKET.SECOND],
      ),
    ).toBe(true);
    expect(
      Bun.deepEquals(outcome.result.metadata["additionalCaseNumbers"], [
        DOCKET.SECOND,
      ]),
    ).toBe(true);
  });

  test("malformed persisted aliases are rejected instead of dropped", async () => {
    const outcome = await replay({
      raw: new Uint8Array(),
      contentType: "text/html",
      caseNumber: DOCKET.FIRST,
      sourceDocumentId: UNID.FIRST,
      language: "cs",
      court: "Nejvyšší soud",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: { additionalCaseNumbers: [DOCKET.SECOND, 7] },
    });

    expect(outcome).toEqual({
      type: "rejected",
      rejection: "incomplete-metadata",
      detail: "stored additional case numbers are malformed",
    });
  });

  test("a historical source URL is not reinterpreted as a Domino id", async () => {
    const outcome = await replay({
      raw: new Uint8Array(),
      contentType: "text/html",
      caseNumber: DOCKET.FIRST,
      sourceDocumentId:
        "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/record",
      language: "cs",
      court: "Nejvyšší soud",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    });

    expect(outcome).toEqual({
      type: "rejected",
      rejection: "identity-mismatch",
      detail: "stored source document id is not a CZ-NS Domino universal id",
    });
  });
});
