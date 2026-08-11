/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import { Result, panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import {
  listingIdentityKey,
  parseListingIdentityKey,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  ReconciliationListingItem,
  ReconciliationSlicePage,
  SourceReconciliation,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  czUsAdapter,
  czUsListingIdentity,
} from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import type { ListedDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

/** Frozen so "the current year" and "yesterday" are the same in every test. */
const NOW = new Date("2026-08-08T12:00:00.000Z");
const LATEST_CLOSED_DAY = "7.8.2026";
const LISTING_PAGE_SIZE = 80;

const reconciliation: SourceReconciliation =
  czUsAdapter.reconciliation ?? panic("cz-us states no reconciliation");

// ── Publisher fixtures ───────────────────────────────────

/**
 * A NALUS result row as the court renders it: a ResultDetail anchor carrying
 * the internal record id, an ECLI, and a second row whose ShowLink action
 * carries the GetText retrieval identifier.
 */
type MockRow = {
  /** Internal record id; absent renders the malformed detail link NALUS emits. */
  id?: string | undefined;
  /** GetText `sz`; null renders a row whose text action was withdrawn. */
  sz?: string | null | undefined;
  caseNumber: string;
  date: string;
  ecli?: string | undefined;
};

const makeSearchForm = (): string => `
<html><body>
  <input id="__VIEWSTATE" value="view-state" />
  <input id="__VIEWSTATEGENERATOR" value="generator" />
  <input id="__EVENTVALIDATION" value="validation" />
</body></html>`;

const makeNoResultsPage = (): string => `
<html><body>
  <span id="ctl00_MainContent_lbError" class="labelError">
    Pro zadaná kritéria nebyly nalezeny žádné záznamy.
  </span>
  <input id="ctl00_bResults" disabled="disabled" />
</body></html>`;

const makeTextPage = (row: MockRow, counter: string): string => `
<html><body>
  <span id="lblRegistrySign">${row.caseNumber} ze dne ${row.date}</span>
  <span id="lblDecisionForm">Nález</span>
  <span id="lblParallelQuotation"></span>
  <span id="lblPopularName"></span>
  <input name="registrySignHidden" value="${row.caseNumber} #${counter} ze dne ${row.date}" />
  <table class="DocContent"><tr><td>
    ${"Lorem ipsum dolor sit amet. ".repeat(10)}
    Jan Novák (soudce zpravodaj)
  </td></tr></table>
</body></html>`;

const makeAbstractPage = (): string => `
<html><body>
  <table class="abstractContent"><tr><td></td></tr></table>
  <table class="legalSentenceContent"><tr><td></td></tr></table>
</body></html>`;

const counterOf = (row: MockRow): string =>
  /_(?<counter>\d+)$/u.exec(row.sz ?? "")?.groups?.["counter"] ?? "1";

const makeResultsPage = ({
  rows,
  rangeFrom,
  reported,
  banner,
}: {
  rows: readonly MockRow[];
  rangeFrom: number;
  reported: number;
  banner?: string | undefined;
}): string => {
  const body = rows
    .map((row, index) => {
      const detailHref =
        row.id === undefined
          ? `ResultDetail.aspx?malformed=true&pos=${rangeFrom + index}&cnt=${reported}`
          : `ResultDetail.aspx?id=${row.id}&pos=${rangeFrom + index}&cnt=${reported}&typ=result`;
      const textAction =
        row.sz === null || row.sz === undefined
          ? ""
          : `<img onclick='javascript:ShowLink("https://nalus.usoud.cz:443/Search/GetText.aspx?sz=${row.sz}", "Odkaz", "")' />`;
      return `
<tr class='resultData${index % 2}'>
  <td></td>
  <td><a href='${detailHref}'>${row.caseNumber} #${counterOf(row)}</a><br />${row.ecli ?? ""}<br />Jan Novák</td>
</tr>
<tr class='resultData${index % 2}' valign="top">
  <td>${textAction}</td>
</tr>`;
    })
    .join("");
  const rendered =
    banner ??
    `Výsledky ${rangeFrom} - ${rangeFrom + rows.length - 1} z celkem ${reported}`;
  return `<html><body>${rendered}<table>${body}</table>${rendered}</body></html>`;
};

// ── Fetch harness ────────────────────────────────────────

type MockOptions = {
  rows?: readonly MockRow[];
  rangeFrom?: number;
  reported?: number;
  /** Render the publisher's own "no records" answer instead of results. */
  statedEmpty?: boolean;
  /** Replace the result count banner, e.g. to drop it entirely. */
  banner?: string | undefined;
  formStatus?: number;
  resultsStatus?: number;
  textStatus?: number;
  /** Serve a GetText page the decision parser cannot read. */
  unparseableText?: boolean;
  onPost?: (form: URLSearchParams) => void;
  onResults?: (url: URL) => void;
};

const resolveUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const requestMethod = (
  input: string | URL | Request,
  init?: RequestInit,
): string => init?.method ?? (input instanceof Request ? input.method : "GET");

const installSearchMock = ({
  rows = [],
  rangeFrom = 1,
  reported = rows.length,
  statedEmpty = false,
  banner,
  formStatus = 200,
  resultsStatus = 200,
  textStatus = 200,
  unparseableText = false,
  onPost,
  onResults,
}: MockOptions): void => {
  const bySz = new Map(
    rows.flatMap((row) => (row.sz ? [[row.sz, row] as const] : [])),
  );
  globalThis.fetch = asFetchMock(
    mock((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(resolveUrl(input));
      const method = requestMethod(input, init);
      if (url.pathname.endsWith("/Search/Search.aspx") && method === "GET") {
        return Promise.resolve(
          new Response(makeSearchForm(), {
            status: formStatus,
            headers: { "Set-Cookie": "ASP.NET_SessionId=test-session; Path=/" },
          }),
        );
      }
      if (url.pathname.endsWith("/Search/Search.aspx")) {
        onPost?.(
          new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
        );
        return Promise.resolve(
          statedEmpty
            ? new Response(makeNoResultsPage())
            : new Response(null, {
                status: 302,
                headers: { Location: "/Search/Results.aspx" },
              }),
        );
      }
      if (url.pathname.endsWith("/Search/Results.aspx")) {
        onResults?.(url);
        return Promise.resolve(
          new Response(makeResultsPage({ rows, rangeFrom, reported, banner }), {
            status: resultsStatus,
          }),
        );
      }
      if (url.pathname.endsWith("/Search/GetText.aspx")) {
        const row = bySz.get(url.searchParams.get("sz") ?? "");
        if (row === undefined) {
          return Promise.resolve(new Response("missing", { status: 404 }));
        }
        return Promise.resolve(
          new Response(
            unparseableText
              ? "<html><body>detail unavailable</body></html>"
              : makeTextPage(row, counterOf(row)),
            { status: textStatus },
          ),
        );
      }
      if (url.pathname.endsWith("/Search/GetAbstract.aspx")) {
        return Promise.resolve(new Response(makeAbstractPage()));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    }),
  );
};

/**
 * The error a promise rejected with, or null. bun-types declares
 * `.rejects.toThrow` as void, so awaiting it trips type-aware lint.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => null,
    (error: unknown) => error,
  );

const listSlice = async (
  slice: string,
  page = 0,
): Promise<ReconciliationSlicePage> =>
  await reconciliation.listSlicePage({ slice, page });

/** The one item a single-row fixture lists, as the ledger would park it. */
const onlyItem = (
  listed: ReconciliationSlicePage,
): ReconciliationListingItem => {
  const item = listed.items.at(0);
  expect(item).toBeDefined();
  return item ?? { identity: { type: "unidentifiable" }, payload: null };
};

// ── Slice arithmetic ─────────────────────────────────────

describe("cz-us reconciliation slices", () => {
  beforeAll(() => {
    setSystemTime(NOW);
  });

  afterAll(() => {
    setSystemTime();
  });

  test("starts at the court's first year and steps one year at a time", () => {
    expect(reconciliation.firstSlice).toBe("1993");
    expect(reconciliation.sliceOf(NOW)).toBe("2026");
    expect(reconciliation.nextSlice("1993")).toBe("1994");
    expect(reconciliation.previousSlice("1994")).toBe("1993");
  });

  test("stops at the tip and at the first slice", () => {
    expect(reconciliation.nextSlice("2026")).toBeNull();
    expect(reconciliation.nextSlice("2025")).toBe("2026");
    expect(reconciliation.previousSlice("1993")).toBeNull();
  });

  test("walks every year between the first slice and the tip, once", () => {
    const walked: string[] = [];
    let cursor: string | null = reconciliation.firstSlice;
    while (cursor !== null) {
      walked.push(cursor);
      cursor = reconciliation.nextSlice(cursor);
    }

    expect(walked.at(0)).toBe("1993");
    expect(walked.at(-1)).toBe(reconciliation.sliceOf(NOW));
    expect(walked).toHaveLength(2026 - 1993 + 1);
    expect(new Set(walked).size).toBe(walked.length);
    // The ledger orders `(source, slice)` rows by byte comparison, so walk
    // order and lexicographic order have to be the same sequence.
    expect([...walked].sort()).toEqual(walked);
  });

  test("previousSlice inverts nextSlice across the whole walk", () => {
    for (let year = 1993; year < 2026; year += 1) {
      const slice = String(year);
      const next = reconciliation.nextSlice(slice);
      expect(next).not.toBeNull();
      expect(reconciliation.previousSlice(next ?? "")).toBe(slice);
    }
  });

  test("the tip window is the current year and the one before it", () => {
    expect(reconciliation.tipWindowDays).toBe(2);
    const window: string[] = [];
    let cursor: string | null = reconciliation.sliceOf(NOW);
    while (cursor !== null && window.length < reconciliation.tipWindowDays) {
      window.push(cursor);
      cursor = reconciliation.previousSlice(cursor);
    }
    expect(window).toEqual(["2026", "2025"]);
  });

  test("refuses a slice that is not a decision year", () => {
    expect(() => reconciliation.nextSlice("2026-08")).toThrow();
    expect(() => reconciliation.previousSlice("")).toThrow();
    expect(() => reconciliation.nextSlice("199")).toThrow();
  });
});

// ── Identity mapping ─────────────────────────────────────

describe("czUsListingIdentity", () => {
  const listedWith = (fields: Partial<ListedDecision>): ListedDecision => ({
    caseNumber: "I.ÚS 1057/24",
    quarantineId: "e3b0c44298fc1c149afbf4c8996fb924",
    quarantineRepairIds: ["e3b0c44298fc1c149afbf4c8996fb924"],
    listingHtml: "<tr></tr>",
    sourceDocumentId: "nalus-record:104387",
    sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1057-24_1",
    ...fields,
  });

  test("keys a row on the publisher identity the ingest stores", () => {
    for (const sourceDocumentId of [
      "nalus-record:104387",
      "nalus-sz:1-1057-24_1",
      "nalus-ecli:ECLI:CZ:US:2024:1.US.1057.24.1",
      "nalus-quarantine:e3b0c44298fc1c149afbf4c8996fb924",
    ]) {
      expect(czUsListingIdentity(listedWith({ sourceDocumentId }))).toEqual({
        type: "document",
        sourceDocumentId,
      });
    }
  });

  test("round-trips through the ledger's key format", () => {
    const identity = czUsListingIdentity(
      listedWith({ sourceDocumentId: "nalus-record:104387" }),
    );
    const key = listingIdentityKey(identity);

    expect(key).toBe("document:nalus-record:104387");
    expect(parseListingIdentityKey(key ?? "")).toEqual(identity);
  });

  test("refuses an id the decision table could never store", () => {
    // Longer than SOURCE_DOCUMENT_ID_MAX_LENGTH: a row keyed on it would be
    // counted as missing on every pass, because no held row can ever match it.
    expect(
      czUsListingIdentity(
        listedWith({ sourceDocumentId: `nalus-sz:${"9".repeat(300)}` }),
      ),
    ).toEqual({ type: "unidentifiable" });
    expect(czUsListingIdentity(listedWith({ sourceDocumentId: "" }))).toEqual({
      type: "unidentifiable",
    });
  });
});

// ── Listing walk ─────────────────────────────────────────

describe("cz-us listSlicePage", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    setSystemTime(NOW);
  });

  afterAll(() => {
    setSystemTime();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const rowsFor = (count: number, offset = 0): MockRow[] =>
    Array.from({ length: count }, (_, index) => ({
      id: String(104_387 + offset + index),
      sz: `1-${1057 + offset + index}-24_1`,
      caseNumber: `I.ÚS ${1057 + offset + index}/24`,
      date: "12. 3. 2024",
      ecli: `ECLI:CZ:US:2024:1.US.${1057 + offset + index}.24.1`,
    }));

  test("asks the publisher for the whole decision year, at the listing page size", async () => {
    let submitted: URLSearchParams | undefined;
    let requested: URL | undefined;
    installSearchMock({
      rows: rowsFor(3),
      reported: 3,
      onPost: (form) => {
        submitted = form;
      },
      onResults: (url) => {
        requested = url;
      },
    });

    await listSlice("2024");

    expect(submitted?.get("ctl00$MainContent$decidedFrom")).toBe("1.1.2024");
    expect(submitted?.get("ctl00$MainContent$decidedTo")).toBe("31.12.2024");
    expect(submitted?.get("ctl00$MainContent$resultsPageSize")).toBe("80");
    // NALUS keeps the current day's result set live, so the walk is pinned to
    // the last closed publication day exactly as the crawl is.
    expect(submitted?.get("ctl00$MainContent$availableTo")).toBe(
      LATEST_CLOSED_DAY,
    );
    expect(requested?.searchParams.get("page")).toBeNull();
  });

  test("keys every listed record and derives the page count from the banner", async () => {
    installSearchMock({ rows: rowsFor(80), rangeFrom: 1, reported: 200 });

    const listed = await listSlice("2024");

    expect(listed.items).toHaveLength(80);
    expect(listed.totalPages).toBe(Math.ceil(200 / LISTING_PAGE_SIZE));
    expect(listed.items.at(0)?.identity).toEqual({
      type: "document",
      sourceDocumentId: "nalus-record:104387",
    });
    expect(
      new Set(listed.items.map(({ identity }) => listingIdentityKey(identity)))
        .size,
    ).toBe(80);
  });

  test("requests a later page and reads the banner against it", async () => {
    let requested: URL | undefined;
    installSearchMock({
      rows: rowsFor(40, 160),
      rangeFrom: 161,
      reported: 200,
      onResults: (url) => {
        requested = url;
      },
    });

    const listed = await listSlice("2024", 2);

    expect(requested?.searchParams.get("page")).toBe("2");
    expect(listed.items).toHaveLength(40);
    expect(listed.totalPages).toBe(3);
  });

  test("reports a stated-empty year as zero pages", async () => {
    installSearchMock({ statedEmpty: true });

    expect(await listSlice("1993")).toEqual({ items: [], totalPages: 0 });
  });

  test.each([
    ["a failed search form", { formStatus: 500 }],
    ["a failed results page", { resultsStatus: 503 }],
    ["a results page with no count banner", { banner: "" }],
  ] as const)(
    "throws on %s rather than reporting an empty year",
    async (_label, options) => {
      installSearchMock({ rows: rowsFor(1), reported: 1, ...options });

      // Flattened to an empty page this would record the year as settled, and
      // the ledger would never revisit it.
      expect(await rejectionOf(listSlice("2024"))).toBeInstanceOf(Error);
    },
  );

  test("throws when the requested page is not the page served", async () => {
    installSearchMock({ rows: rowsFor(80), rangeFrom: 1, reported: 200 });

    expect(await rejectionOf(listSlice("2024", 1))).toBeInstanceOf(Error);
  });
});

// ── Building one listed record ───────────────────────────

describe("cz-us buildDecision", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    setSystemTime(NOW);
  });

  afterAll(() => {
    setSystemTime();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const servedRow: MockRow = {
    id: "104387",
    sz: "1-1057-24_1",
    caseNumber: "I.ÚS 1057/24",
    date: "12. 3. 2024",
    ecli: "ECLI:CZ:US:2024:1.US.1057.24.1",
  };

  const itemFor = async (
    options: MockOptions,
  ): Promise<ReconciliationListingItem> => {
    installSearchMock(options);
    return onlyItem(await listSlice("2024"));
  };

  test("builds the decision the walk keyed, under the same identity", async () => {
    const item = await itemFor({ rows: [servedRow], reported: 1 });

    const built = await reconciliation.buildDecision(item.payload);

    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    // The key the walk parks under has to be the key the stored decision is
    // later found under; if the two ever drift the slice records short forever.
    expect(listingIdentityKey(item.identity)).toBe(
      `document:${built.decision.sourceDocumentId ?? ""}`,
    );
    expect(built.decision.sourceDocumentId).toBe("nalus-record:104387");
    expect(built.decision).toMatchObject({
      caseNumber: "I.ÚS 1057/24",
      country: "CZE",
      language: "cs",
      decisionDate: "2024-03-12",
    });
    expect(built.decision.isListingOnly).toBeUndefined();
    expect(built.decision.fulltext).toContain("Lorem ipsum");
  });

  test.each([
    [
      "a record NALUS serves no text for",
      { rows: [servedRow], reported: 1, textStatus: 404 },
    ],
    [
      "a record whose text is unreadable",
      { rows: [servedRow], reported: 1, unparseableText: true },
    ],
    [
      "a row whose text action was withdrawn",
      { rows: [{ ...servedRow, sz: null }], reported: 1 },
    ],
    [
      "a counted row exposing no NALUS identity at all",
      {
        rows: [{ caseNumber: "Pl.ÚS 10/24", date: "4. 1. 2024" }],
        reported: 1,
      },
    ],
  ] as const)("reports %s as detail-unavailable", async (_label, options) => {
    const item = await itemFor(options);

    // Never `built`: writing the listing-only row the crawl keeps would make
    // the identity held and take the document out of every later pass.
    expect(await reconciliation.buildDecision(item.payload)).toEqual({
      type: "detail-unavailable",
    });
  });

  test("throws on a transient text failure instead of retiring the record", async () => {
    const item = await itemFor({
      rows: [servedRow],
      reported: 1,
      textStatus: 502,
    });

    expect(
      await rejectionOf(reconciliation.buildDecision(item.payload)),
    ).toBeInstanceOf(Error);
  });

  test.each([
    ["an empty object", {}],
    ["a shape from before the search rewrite", { sz: "1-1057-24_1" }],
    [
      "a payload missing its listing markup",
      {
        caseNumber: "I.ÚS 1057/24",
        sourceDocumentId: "nalus-record:104387",
        quarantineId: "e3b0c44298fc1c149afbf4c8996fb924",
        quarantineRepairIds: ["e3b0c44298fc1c149afbf4c8996fb924"],
        sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1057-24_1",
      },
    ],
    [
      "a well-formed payload keyed on an unstorable id",
      {
        caseNumber: "I.ÚS 1057/24",
        sourceDocumentId: `nalus-sz:${"9".repeat(300)}`,
        quarantineId: "e3b0c44298fc1c149afbf4c8996fb924",
        quarantineRepairIds: ["e3b0c44298fc1c149afbf4c8996fb924"],
        listingHtml: "<tr></tr>",
        sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1057-24_1",
        sz: "1-1057-24_1",
      },
    ],
    ["a JSON scalar", "nalus-record:104387"],
    ["a JSON null", null],
  ] as const)("reports %s as unkeyable", async (_label, payload) => {
    installSearchMock({ rows: [servedRow], reported: 1 });

    expect(await reconciliation.buildDecision(payload)).toEqual({
      type: "unkeyable",
    });
  });

  test("the marker the crawl stores is what makes heldness require detail", async () => {
    installSearchMock({ rows: [servedRow], reported: 1, textStatus: 404 });

    const crawled = await czUsAdapter.fetchPage(null, {});
    const item = onlyItem(await listSlice("2024"));

    // Three halves of one decision, asserted together because each alone is
    // silently wrong. The crawl keeps the row the reconciliation refuses and
    // marks it `isListingOnly`; the capability declares that such a row is not
    // held. Drop the marker and the declaration filters nothing; drop the
    // declaration and the marked row reads as held, the slice reads
    // reconciled, and NALUS is never asked for that text again.
    expect(Result.isOk(crawled)).toBe(true);
    expect(
      Result.isOk(crawled) ? crawled.value.decisions.at(0) : null,
    ).toMatchObject({ isListingOnly: true });
    expect(await reconciliation.buildDecision(item.payload)).toEqual({
      type: "detail-unavailable",
    });
    expect(reconciliation.heldRequiresDetail).toBe(true);
  });

  test("survives the JSON round-trip the ledger parks payloads through", async () => {
    const item = await itemFor({ rows: [servedRow], reported: 1 });

    const serialized = JSON.stringify(item.payload);
    const parked: unknown = JSON.parse(serialized);

    expect((await reconciliation.buildDecision(parked)).type).toBe("built");
  });
});
