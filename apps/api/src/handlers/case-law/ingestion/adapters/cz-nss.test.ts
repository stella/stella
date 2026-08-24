/**
 * The cz-nss listing reconciliation capability, and the parser it keys on.
 *
 * Everything here drives the adapter's own exports against a stubbed portal.
 * A test that re-implemented the parser would certify its own copy of the
 * regexes rather than the ones the crawl runs, which is how this suite's
 * predecessor came to assert a citation pattern the adapter no longer had.
 */

import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

import type { StoredRawReparseInput } from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildCzNssDecision,
  courtFromEcli,
  CZ_ECLI_COURTS,
  czNssAdapter,
  czNssExpectedRows,
  czNssListingIdentity,
  czNssTotalPages,
  CZ_NSS_CONTINUATION_PAGE_ROWS,
  CZ_NSS_FIRST_SLICE,
  CZ_NSS_FIRST_PAGE_ROWS,
  parseResultRows,
} from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import type { ParsedRow } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import {
  listingIdentityKey,
  SOURCE_DOCUMENT_ID_MAX_LENGTH,
} from "@/api/lib/legal-search/ingestion-types";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const reconciliation = requireReconciliation(czNssAdapter);

const BASE_URL = "https://vyhledavac.nssoud.cz";

// ── Portal-shaped fixtures ───────────────────────────────

/**
 * A results row exactly as the portal renders one: entity-escaped Czech, the
 * docket carrying its sheet number, and the citation anchor the docket is read
 * from. Shortened stand-ins would let a citation or id rule pass here and fail
 * on live traffic.
 */
type RowFixture = {
  index: number;
  documentId: string;
  /** The docket as the citation states it, sheet number included. */
  citedCaseNumber: string;
  displayedCaseNumber: string;
  court: string;
  date: string;
};

const rowBlock = ({
  citedCaseNumber,
  court,
  date,
  displayedCaseNumber,
  documentId,
  index,
}: RowFixture): string => `<tbody>
  <tr>
    <td scope="row" rowspan="1" class="font-weight-bold"> ${index + 1} </td>
    <td rowspan="1">
      <input name="ZobrazeneVysledky[${index}].ID" id="ZobrazeneVysledky_${index}__ID" type="hidden" value="${documentId}">
    </td>
    <td> ${date} </td>
    <td> ${displayedCaseNumber} </td>
    <td> ${court} </td>
    <td> Rozsudek </td>
    <td rowspan="1" class="text-nowrap">
      <a target="_blank" href="/DokumentOriginal/Html/${documentId}"><span title="Html soubor"></span></a>
      <a target="_blank" href="/DokumentDetail/Index/${documentId}"><span title="Detail dokumentu"></span></a>
      <a onclick="javascript: return CopyToCB(this);" title="Citace: rozsudek ${court} ze dne ${date}, &#x10D;j. ${citedCaseNumber}"><span></span></a>
    </td>
  </tr>
</tbody>`;

const MUNICIPAL_ROW = {
  index: 0,
  documentId: "784237",
  citedCaseNumber: "1 Az 4/2026-79",
  displayedCaseNumber: "1&#xA0;Az&#xA0;4/2026&#xA0;-&#xA0;79",
  court: "M&#x11B;stsk&#xFD; soud v Praze",
  date: "10.06.2026",
} as const satisfies RowFixture;

const REGIONAL_ROW = {
  index: 1,
  documentId: "783863",
  citedCaseNumber: "52 Af 4/2026-66",
  displayedCaseNumber: "52&#xA0;Af&#xA0;4/2026&#xA0;-&#xA0;66",
  court: "Krajsk&#xE9;ho soudu v Hradci Kr&#xE1;lov&#xE9;",
  date: "10.06.2026",
} as const satisfies RowFixture;

/**
 * A page's worth of distinct rows. Sized from the adapter's own page constant
 * so the fixture cannot drift from the cardinality the walk enforces.
 */
const fullPageRows = (count: number): RowFixture[] =>
  Array.from({ length: count }, (_, index) => ({
    index,
    documentId: String(780_000 + index),
    citedCaseNumber: `${index + 1} As ${index + 1}/2026-10`,
    displayedCaseNumber: `${index + 1}&#xA0;As&#xA0;${index + 1}/2026&#xA0;-&#xA0;10`,
    court: "Nejvy&#x161;&#x161;&#xED; spr&#xE1;vn&#xED; soud",
    date: "10.06.2026",
  }));

/** The pagination state the portal hands to its own infinite scroll. */
const CURR_PARAMS_JSON =
  "[{\\u0022Id\\u0022:19,\\u0022TechnickyNazev\\u0022:\\u0022datumvydanirozhodnuti\\u0022,\\u0022vyhledavaciPodminkaHodnota\\u0022:[{\\u0022HodnotaDatumACasOd\\u0022:\\u00222026-06-10T00:00:00\\u0022,\\u0022HodnotaDatumACasDo\\u0022:\\u00222026-06-10T00:00:00\\u0022}]}]";
const CURR_PARAMS_DECODED =
  '[{"Id":19,"TechnickyNazev":"datumvydanirozhodnuti","vyhledavaciPodminkaHodnota":[{"HodnotaDatumACasOd":"2026-06-10T00:00:00","HodnotaDatumACasDo":"2026-06-10T00:00:00"}]}]';
const CURR_SORT = " order by  zvht38.Hodnota NOOR , zvhdt1.Hodnota DESC ";

const scriptBlock = `<script type="text/javascript">
    var moreRowsUrl = '/Home/MyResTRowsCont';
    var currParams = '${CURR_PARAMS_JSON}';
    var currViewId = '1';
    var currSort = '${CURR_SORT}';
</script>`;

type SearchPageOptions = {
  statedCount: number;
  rows: readonly RowFixture[];
  withScript?: boolean;
};

const searchPage = ({
  rows,
  statedCount,
  withScript = true,
}: SearchPageOptions): string => `<html><body>
  <div id="contenttable"><div class="col-12"><div class="row justify-content-left">
    <h6>Počet nalezených záznamů: ${statedCount}</h6>
  </div></div></div>
  <table class="infinite-scroll">${rows.map(rowBlock).join("\n")}</table>
  ${withScript ? scriptBlock : ""}
</body></html>`;

/** The landing page, which only hands out an antiforgery token. */
const SESSION_PAGE = `<html><body><form>
  <input type="hidden" name="__RequestVerificationToken" value="token-for-tests" />
  <input type="text" name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" />
</form></body></html>`;

const DOCUMENT_HTML = `<html><body>
  <p>Nejvyšší správní soud rozhodl v senátě složeném z předsedy JUDr. Karla Šimky
  a soudců JUDr. Jaroslava Vlašína a Mgr. Evy Šonkové v právní věci žalobce:
  A. B., proti žalovanému: Ministerstvo vnitra, o kasační stížnosti.</p>
  <p>Kasační stížnost se zamítá. Žádný z účastníků nemá právo na náhradu nákladů
  řízení o kasační stížnosti.</p>
</body></html>`;

const detailPage = (ecli: string): string => `<html><body>
  <div id="ecli"><span class="det-textitle">ECLI:</span><span class="det-textval" title="${ecli}">${ecli}</span></div>
  <div id="druhdokumentuavyrokrozhodnuti"><span class="det-textval">Rozsudek</span></div>
  <div id="datumvydanirozhodnuti"><span class="det-textval">10.06.2026</span></div>
</body></html>`;

// ── Fetch stub ───────────────────────────────────────────

type RecordedRequest = { method: string; url: string; body: string };

type StubOptions = {
  /** Search responses, one per POST /Home/Index, last one repeats. */
  search?: readonly Response[];
  /** Continuation responses, one per POST /Home/MyResTRowsCont. */
  continuation?: readonly Response[];
  /** Status for both document endpoints; 200 serves the fixture. */
  documentStatus?: number;
  /** Status for the detail page alone; defaults to `documentStatus`. */
  detailStatus?: number;
};

const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const installStub = ({
  continuation = [],
  documentStatus = 200,
  detailStatus = documentStatus,
  search = [],
}: StubOptions): { requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  let searchCalls = 0;
  let continuationCalls = 0;

  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      requests.push({
        method,
        url: url.toString(),
        body: typeof init?.body === "string" ? init.body : "",
      });

      const answer = (): Response => {
        if (url.pathname === "/Home/Index" && method === "POST") {
          const next = search.at(Math.min(searchCalls, search.length - 1));
          searchCalls += 1;
          return next ?? htmlResponse("no search response stubbed", 500);
        }
        if (url.pathname === "/Home/MyResTRowsCont") {
          const next = continuation.at(
            Math.min(continuationCalls, continuation.length - 1),
          );
          continuationCalls += 1;
          return next ?? htmlResponse("", 200);
        }
        if (url.pathname.startsWith("/DokumentDetail/Index/")) {
          return detailStatus === 200
            ? htmlResponse(detailPage("ECLI:CZ:MSPH:2026:1.Az.4.2026.79"))
            : htmlResponse("", detailStatus);
        }
        if (url.pathname.startsWith("/DokumentOriginal/Html/")) {
          return documentStatus === 200
            ? htmlResponse(DOCUMENT_HTML)
            : htmlResponse("", documentStatus);
        }
        if (url.pathname.startsWith("/DokumentOriginal/Text/")) {
          return documentStatus === 200
            ? new Response(DOCUMENT_HTML)
            : new Response(null, { status: documentStatus });
        }
        if (url.pathname === "/") {
          return htmlResponse(SESSION_PAGE);
        }
        return htmlResponse(`unexpected request: ${url.toString()}`, 500);
      };

      return await Promise.resolve(answer());
    },
  );

  return { requests };
};

/**
 * bun-types declares `.rejects.toThrow` as void, so awaiting it trips
 * type-aware lint; capture the rejection explicitly instead.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => null,
    (error: unknown) => error,
  );

/**
 * A payload as the loop hands it back: parked as JSONB, so keys whose value
 * was `undefined` are simply gone. `structuredClone` would keep them, which is
 * why the round trip has to be JSON.
 */
const throughJsonb = (value: unknown): unknown =>
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip is the property under test, not an incidental deep clone
  JSON.parse(JSON.stringify(value));

const SLICE = "2026-06-10";

test("allows the NSS listing endpoints to use their source-specific budget", async () => {
  installStub({ search: [htmlResponse("", 503)] });
  const invalidation = await czNssAdapter.fetchPage("2026-08-20:0", {});
  expect(invalidation.isErr()).toBe(true);

  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
    (milliseconds) => {
      timeouts.push(milliseconds);
      return originalTimeout(milliseconds);
    },
  );
  try {
    installStub({ search: [htmlResponse("", 503)] });
    const failed = await czNssAdapter.fetchPage("2026-08-20:0", {});
    expect(failed.isErr()).toBe(true);
    expect(timeouts).toEqual([120_000, 60_000, 60_000]);
    timeouts.length = 0;

    installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: CZ_NSS_FIRST_PAGE_ROWS + 1,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
      ],
      continuation: [htmlResponse(rowBlock(REGIONAL_ROW))],
    });
    const page = await czNssAdapter.fetchPage(`${SLICE}:1`, {});

    expect(page.isOk()).toBe(true);
    expect(timeouts.slice(0, 4)).toEqual([120_000, 60_000, 60_000, 60_000]);
  } finally {
    timeoutSpy.mockRestore();
  }
});

// ── Slice arithmetic ─────────────────────────────────────

describe("cz-nss reconciliation slices", () => {
  beforeEach(() => {
    setSystemTime(new Date("2026-08-11T09:30:00.000Z"));
  });

  afterAll(() => {
    setSystemTime();
  });

  test("starts at the first day the portal publishes a decision for", () => {
    expect(reconciliation.firstSlice).toBe("2003-02-04");
    expect(CZ_NSS_FIRST_SLICE).toBe(reconciliation.firstSlice);
  });

  test("slices a UTC instant to its calendar day", () => {
    expect(reconciliation.sliceOf(new Date("2026-06-10T23:59:59.999Z"))).toBe(
      "2026-06-10",
    );
    // A local-time day would answer 2026-06-10 here in any negative offset.
    expect(reconciliation.sliceOf(new Date("2026-06-11T00:00:00.000Z"))).toBe(
      "2026-06-11",
    );
  });

  test("steps across month and year boundaries in both directions", () => {
    expect(reconciliation.nextSlice("2024-02-28")).toBe("2024-02-29");
    expect(reconciliation.previousSlice("2024-03-01")).toBe("2024-02-29");
    expect(reconciliation.nextSlice("2025-12-31")).toBe("2026-01-01");
    expect(reconciliation.previousSlice("2026-01-01")).toBe("2025-12-31");
  });

  test("stops at the ends of the walk", () => {
    expect(reconciliation.previousSlice(CZ_NSS_FIRST_SLICE)).toBeNull();
    expect(reconciliation.previousSlice("2003-02-05")).toBe(CZ_NSS_FIRST_SLICE);
    // The tip is today; there is no slice past it to walk into.
    expect(reconciliation.nextSlice("2026-08-11")).toBeNull();
    expect(reconciliation.nextSlice("2026-08-10")).toBe("2026-08-11");
  });

  test("refuses a slice that is not a UTC calendar day", () => {
    expect(() => reconciliation.nextSlice("2026-06")).toThrow(
      "cz-nss slice is not a UTC calendar day",
    );
    expect(() => reconciliation.previousSlice("2026-06-10T00:00:00Z")).toThrow(
      "cz-nss slice is not a UTC calendar day",
    );
    expect(() => reconciliation.nextSlice("2026-02-30")).toThrow(
      "cz-nss slice is not a UTC calendar day",
    );
  });

  test("walk order is the ledger's lexicographic order", () => {
    // The ledger orders slices as plain strings, so every step forward must
    // also be a step up in byte order, and stepping back must undo it.
    let slice = "2025-12-27";
    for (let walked = 0; walked < 40; walked += 1) {
      const next = reconciliation.nextSlice(slice);
      expect(next).not.toBeNull();
      if (next === null) {
        return;
      }
      expect(next > slice).toBe(true);
      expect(reconciliation.previousSlice(next)).toBe(slice);
      slice = next;
    }
  });

  test("tip window is a fortnight, newest first", () => {
    const window = tipWindowSlices(reconciliation, new Date());
    expect(window).toHaveLength(14);
    expect(window.at(0)).toBe("2026-08-11");
    expect(window.at(-1)).toBe("2026-07-29");
  });

  test("tip window truncates at the first slice for a young source", () => {
    expect(
      tipWindowSlices(reconciliation, new Date("2003-02-06T00:00:00.000Z")),
    ).toEqual(["2003-02-06", "2003-02-05", "2003-02-04"]);
  });
});

// ── Parser and identity ──────────────────────────────────

describe("cz-nss listing rows", () => {
  test("reads the docket, the document id and the date off a row", () => {
    const rows = parseResultRows(rowBlock(MUNICIPAL_ROW));
    expect(rows).toHaveLength(1);
    // The sheet number is dropped: a citation names the docket alone.
    expect(rows.at(0)?.caseNumber).toBe("1 Az 4/2026");
    expect(rows.at(0)?.documentId).toBe("784237");
    expect(rows.at(0)?.documentUrl).toBe(
      `${BASE_URL}/DokumentDetail/Index/784237`,
    );
    expect(rows.at(0)?.decisionDate).toBe("10.06.2026");
  });

  test("skips blocks that carry no citation", () => {
    const rows = parseResultRows(
      `<tbody><tr><td>Header row</td></tr></tbody>${rowBlock(REGIONAL_ROW)}`,
    );
    expect(rows.map((row) => row.caseNumber)).toEqual(["52 Af 4/2026"]);
  });

  test("parses every block of a page", () => {
    const rows = parseResultRows(
      searchPage({ statedCount: 2, rows: [MUNICIPAL_ROW, REGIONAL_ROW] }),
    );
    expect(rows.map((row) => row.caseNumber)).toEqual([
      "1 Az 4/2026",
      "52 Af 4/2026",
    ]);
  });

  test("finds nothing in a page that lists nothing", () => {
    expect(parseResultRows("")).toHaveLength(0);
    expect(parseResultRows(searchPage({ statedCount: 0, rows: [] }))).toEqual(
      [],
    );
  });

  test("keys a row on the portal's own document id", () => {
    const row = parseResultRows(rowBlock(MUNICIPAL_ROW)).at(0);
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }
    expect(czNssListingIdentity(row)).toEqual({
      type: "document",
      sourceDocumentId: "784237",
    });
    expect(listingIdentityKey(czNssListingIdentity(row))).toBe(
      "document:784237",
    );
  });

  test("two courts' decisions under one docket are two keys", () => {
    // The portal carries the regional and city administrative courts
    // alongside the NSS, and their dockets are numbered per court; keyed on
    // the docket, two unrelated decisions were one row.
    const municipal = parseResultRows(rowBlock(MUNICIPAL_ROW)).at(0);
    const regional = parseResultRows(
      rowBlock({
        ...REGIONAL_ROW,
        citedCaseNumber: MUNICIPAL_ROW.citedCaseNumber,
      }),
    ).at(0);
    expect(municipal).toBeDefined();
    expect(regional).toBeDefined();
    if (municipal === undefined || regional === undefined) {
      return;
    }
    expect(regional.caseNumber).toBe(municipal.caseNumber);
    expect(listingIdentityKey(czNssListingIdentity(regional))).not.toBe(
      listingIdentityKey(czNssListingIdentity(municipal)),
    );
  });

  test("a row the portal lists without a document link has nothing to key on", () => {
    const row: ParsedRow = {
      caseNumber: "1 Az 4/2026",
      decisionDate: undefined,
      decisionType: undefined,
      outcome: undefined,
      documentUrl: undefined,
      documentId: undefined,
    };
    // Nothing can be read for it, now or later, so counting it as missing
    // would keep its slice short forever.
    expect(czNssListingIdentity(row)).toEqual({ type: "unidentifiable" });
    expect(listingIdentityKey(czNssListingIdentity(row))).toBeNull();
    expect(
      czNssListingIdentity({
        ...row,
        documentId: "9".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      }),
    ).toEqual({ type: "unidentifiable" });
  });
});

// ── Page arithmetic ──────────────────────────────────────

describe("cz-nss page arithmetic", () => {
  test("the two page sizes the portal serves are not the same size", () => {
    // Every case below is vacuous under one size for both.
    expect(CZ_NSS_CONTINUATION_PAGE_ROWS).not.toBe(CZ_NSS_FIRST_PAGE_ROWS);
  });

  const cases = [
    { statedCount: 0, pages: 0, rows: [] },
    { statedCount: 1, pages: 1, rows: [1] },
    { statedCount: 40, pages: 1, rows: [40] },
    { statedCount: 41, pages: 2, rows: [40, 1] },
    { statedCount: 60, pages: 2, rows: [40, 20] },
    { statedCount: 61, pages: 3, rows: [40, 20, 1] },
    { statedCount: 68, pages: 3, rows: [40, 20, 8] },
  ] as const;

  for (const { pages, rows, statedCount } of cases) {
    test(`a day of ${statedCount} records spans ${pages} pages`, () => {
      expect(czNssTotalPages(statedCount)).toBe(pages);
      expect(
        rows.map((_, page) => czNssExpectedRows({ page, statedCount })),
      ).toEqual([...rows]);
      // Every stated record lands on exactly one page, and no page expects a
      // row past the day's end.
      expect(rows.reduce((sum, count) => sum + count, 0)).toBe(statedCount);
      expect(czNssExpectedRows({ page: pages, statedCount })).toBe(0);
    });
  }
});

// ── Listing walk ─────────────────────────────────────────

describe("cz-nss listSlicePage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("searches the day the slice names", async () => {
    const { requests } = installStub({
      search: [
        htmlResponse(
          searchPage({ statedCount: 2, rows: [MUNICIPAL_ROW, REGIONAL_ROW] }),
        ),
      ],
    });

    const listed = await reconciliation.listSlicePage({
      slice: SLICE,
      page: 0,
    });

    const search = requests.at(-1);
    expect(`${search?.method} ${search?.url}`).toBe(
      `POST ${BASE_URL}/Home/Index`,
    );
    // The court's own date field, in its own format.
    expect(search?.body).toContain("HodnotaDatumACasOd=10.06.2026");
    expect(listed.totalPages).toBe(1);
    expect(listed.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: MUNICIPAL_ROW.documentId },
      { type: "document", sourceDocumentId: REGIONAL_ROW.documentId },
    ]);
  });

  test("establishes its own session when it holds none", async () => {
    // The adapter's session cache is module-level, so it is shared with every
    // other suite in this process and its state cannot be assumed. A failed
    // search drops it, which is the adapter's own way of reaching the one
    // state this asserts about.
    const { requests } = installStub({
      search: [
        htmlResponse("upstream failure", 503),
        htmlResponse(searchPage({ statedCount: 1, rows: [MUNICIPAL_ROW] })),
      ],
    });
    await rejectionOf(reconciliation.listSlicePage({ slice: SLICE, page: 0 }));
    requests.length = 0;

    await reconciliation.listSlicePage({ slice: SLICE, page: 0 });

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${BASE_URL}/`,
      `POST ${BASE_URL}/Home/Index`,
    ]);
  });

  test("lists without fetching any document", async () => {
    const { requests } = installStub({
      search: [
        htmlResponse(
          searchPage({ statedCount: 2, rows: [MUNICIPAL_ROW, REGIONAL_ROW] }),
        ),
      ],
    });

    await reconciliation.listSlicePage({ slice: SLICE, page: 0 });

    expect(
      requests.filter(({ url }) => url.includes("/Dokument")),
    ).toHaveLength(0);
  });

  test("payloads replay through buildDecision", async () => {
    installStub({
      search: [
        htmlResponse(searchPage({ statedCount: 1, rows: [MUNICIPAL_ROW] })),
      ],
    });

    const listed = await reconciliation.listSlicePage({
      slice: SLICE,
      page: 0,
    });
    const payload = listed.items.at(0)?.payload;
    // The loop parks the payload as JSONB, so the round trip is the contract.
    expect(throughJsonb(payload)).toEqual({
      caseNumber: "1 Az 4/2026",
      decisionDate: "10.06.2026",
      // The results table states no decision type of its own, so the row's
      // heuristic picks up the displayed reference, non-breaking spaces and
      // all; the detail page's structured type overrides it in the build.
      decisionType: "1 Az 4/2026 - 79",
      documentUrl: `${BASE_URL}/DokumentDetail/Index/784237`,
      documentId: "784237",
    });
  });

  test("derives the page count from the court's own record count", async () => {
    const statedCount = CZ_NSS_FIRST_PAGE_ROWS + 10;
    installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
      ],
    });

    // A day whose count runs past one page is two pages.
    expect(
      (await reconciliation.listSlicePage({ slice: SLICE, page: 0 }))
        .totalPages,
    ).toBe(2);
  });

  test("pages a day of 68 records as 40 inline then 20 and 8", async () => {
    // The day that exposed this: 68 decisions, of which the inline page
    // carries 40 and the continuation endpoint serves 20 at a time.
    const statedCount = 68;
    const { requests } = installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
        htmlResponse(
          searchPage({
            statedCount,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
      ],
      continuation: [
        htmlResponse(
          fullPageRows(CZ_NSS_CONTINUATION_PAGE_ROWS).map(rowBlock).join("\n"),
        ),
        htmlResponse(fullPageRows(8).map(rowBlock).join("\n")),
      ],
    });

    const second = await reconciliation.listSlicePage({
      slice: SLICE,
      page: 1,
    });
    const third = await reconciliation.listSlicePage({ slice: SLICE, page: 2 });

    expect(second.totalPages).toBe(3);
    expect(second.items).toHaveLength(CZ_NSS_CONTINUATION_PAGE_ROWS);
    expect(third.totalPages).toBe(3);
    expect(third.items).toHaveLength(8);

    // The engine's page index is the portal's own `pageNum`.
    const paginated = requests.filter(({ url }) =>
      url.endsWith("/Home/MyResTRowsCont"),
    );
    expect(
      paginated.map(({ body }) => new URLSearchParams(body).get("pageNum")),
    ).toEqual(["1", "2"]);
  });

  test("refuses a first page shorter than the stated count requires", async () => {
    // The exact shape a changed results table would produce: the count still
    // says 50, the parser recovers two rows. Returning them would record the
    // day as holding two decisions and settle it.
    installStub({
      search: [
        htmlResponse(
          searchPage({ statedCount: 50, rows: [MUNICIPAL_ROW, REGIONAL_ROW] }),
        ),
      ],
    });

    const error = await rejectionOf(
      reconciliation.listSlicePage({ slice: SLICE, page: 0 }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("carried 2 of the 40 rows");
  });

  test("refuses a continuation page the endpoint answered empty", async () => {
    // A 200 with no body is how the endpoint answers a query it does not
    // recognise; read as the end of the day it would lose every row past the
    // first page, permanently.
    installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: CZ_NSS_FIRST_PAGE_ROWS + 10,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
      ],
      continuation: [htmlResponse("")],
    });

    expect(
      await rejectionOf(
        reconciliation.listSlicePage({ slice: SLICE, page: 1 }),
      ),
    ).toBeInstanceOf(Error);
  });

  test("asks the portal's own continuation endpoint for a later page", async () => {
    const { requests } = installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: CZ_NSS_FIRST_PAGE_ROWS + 1,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
      ],
      continuation: [htmlResponse(rowBlock(REGIONAL_ROW))],
    });

    const listed = await reconciliation.listSlicePage({
      slice: SLICE,
      page: 1,
    });

    const paginated = requests.at(-1);
    expect(paginated?.url).toBe(`${BASE_URL}/Home/MyResTRowsCont`);
    const body = new URLSearchParams(paginated?.body ?? "");
    // The field names infiniteScroll.js posts, and the query decoded out of
    // the page's JavaScript string literal.
    expect(body.get("vyhledavaciPodminky")).toBe(CURR_PARAMS_DECODED);
    expect(body.get("zobrazeniVysledkuId")).toBe("1");
    expect(body.get("pageNum")).toBe("1");
    expect(body.get("resultOrder")).toBe(CURR_SORT);
    expect(listed.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: REGIONAL_ROW.documentId },
    ]);
  });

  test("a day the court states no records for is empty, not short", async () => {
    installStub({
      search: [htmlResponse(searchPage({ statedCount: 0, rows: [] }))],
    });

    expect(
      await reconciliation.listSlicePage({ slice: "2026-08-09", page: 0 }),
    ).toEqual({ items: [], totalPages: 0 });
  });

  test("a failed search throws rather than reporting an empty day", async () => {
    installStub({ search: [htmlResponse("upstream failure", 503)] });

    expect(
      await rejectionOf(
        reconciliation.listSlicePage({ slice: SLICE, page: 0 }),
      ),
    ).toBeInstanceOf(Error);
  });

  test("a page stating no count throws rather than reporting an empty day", async () => {
    // What the portal serves when the search silently no-ops: the form again,
    // with no record count on it.
    installStub({ search: [htmlResponse(SESSION_PAGE)] });

    const error = await rejectionOf(
      reconciliation.listSlicePage({ slice: SLICE, page: 0 }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("stated no result count");
  });

  test("a page contradicting its own count throws", async () => {
    installStub({
      search: [
        htmlResponse(searchPage({ statedCount: 0, rows: [MUNICIPAL_ROW] })),
      ],
    });

    expect(
      await rejectionOf(
        reconciliation.listSlicePage({ slice: SLICE, page: 0 }),
      ),
    ).toBeInstanceOf(Error);
  });

  test("a results page with no pagination state throws", async () => {
    installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: 50,
            rows: [MUNICIPAL_ROW],
            withScript: false,
          }),
        ),
      ],
    });

    expect(
      await rejectionOf(
        reconciliation.listSlicePage({ slice: SLICE, page: 1 }),
      ),
    ).toBeInstanceOf(Error);
  });

  test("a failed continuation request throws", async () => {
    installStub({
      search: [
        htmlResponse(searchPage({ statedCount: 50, rows: [MUNICIPAL_ROW] })),
      ],
      continuation: [htmlResponse("upstream failure", 500)],
    });

    expect(
      await rejectionOf(
        reconciliation.listSlicePage({ slice: SLICE, page: 1 }),
      ),
    ).toBeInstanceOf(Error);
  });
});

// ── Crawl cursor ─────────────────────────────────────────

describe("cz-nss fetchPage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setSystemTime(new Date("2026-08-11T09:30:00.000Z"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    setSystemTime();
  });

  test("a full continuation page moves the cursor on within the day", async () => {
    // A continuation page is full at half the inline page's size, so a crawl
    // measuring it against the inline size ends the day here and never asks
    // for the records past it.
    installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: 68,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
      ],
      continuation: [
        htmlResponse(
          fullPageRows(CZ_NSS_CONTINUATION_PAGE_ROWS).map(rowBlock).join("\n"),
        ),
      ],
    });

    const page = await czNssAdapter.fetchPage(`${SLICE}:1`, {});

    expect(Result.isError(page)).toBe(false);
    expect(Result.isError(page) ? null : page.value.nextCursor).toBe(
      `${SLICE}:2`,
    );
  }, 30_000);
});

// ── Per-item build ───────────────────────────────────────

describe("cz-nss court from ECLI", () => {
  // Stated here independently of the adapter's map, so a wrong name in the
  // map fails this rather than being read back as the expectation.
  const EXPECTED_COURTS = {
    NSS: "Nejvyšší správní soud",
    MSPH: "Městský soud v Praze",
    KSBR: "Krajský soud v Brně",
    KSCB: "Krajský soud v Českých Budějovicích",
    KSHK: "Krajský soud v Hradci Králové",
    KSOS: "Krajský soud v Ostravě",
    KSPH: "Krajský soud v Praze",
    KSPL: "Krajský soud v Plzni",
    KSUL: "Krajský soud v Ústí nad Labem",
  } as const;

  test("every declared court code resolves to its court, and nothing else does", () => {
    expect(CZ_ECLI_COURTS).toEqual(EXPECTED_COURTS);
    for (const [code, court] of Object.entries(EXPECTED_COURTS)) {
      expect(courtFromEcli(`ECLI:CZ:${code}:2021:52.Af.4.2020.66`)).toBe(court);
    }
  });

  test("no ECLI, or a code the map does not know, keeps the portal's label", () => {
    expect(courtFromEcli(undefined)).toBe("Nejvyšší správní soud");
    expect(courtFromEcli("ECLI:CZ:XXXX:2026:1.Az.4.2026.79")).toBe(
      "Nejvyšší správní soud",
    );
  });
});

describe("cz-nss buildDecision", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const listedRow = async (): Promise<unknown> => {
    installStub({
      search: [
        htmlResponse(searchPage({ statedCount: 1, rows: [MUNICIPAL_ROW] })),
      ],
    });
    const listed = await reconciliation.listSlicePage({
      slice: SLICE,
      page: 0,
    });
    const payload = listed.items.at(0)?.payload;
    // Through JSON, because that is how the loop hands a payload back.
    return throughJsonb(payload);
  };

  test("builds a decision from a listed payload", async () => {
    const payload = await listedRow();
    installStub({ search: [] });

    const built = await reconciliation.buildDecision(payload);

    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision.caseNumber).toBe("1 Az 4/2026");
    expect(built.decision.language).toBe("cs");
    // The portal lists the city court's decision; the ECLI names the court,
    // so the row is stored under it rather than under the portal's own.
    expect(built.decision.court).toBe("Městský soud v Praze");
    expect(built.decision.ecli).toBe("ECLI:CZ:MSPH:2026:1.Az.4.2026.79");
    expect(built.decision.fulltext ?? "").not.toBe("");
    // Silent drift here is the whole failure mode: a walk that keys a row one
    // way and a build that stores it another leaves the slice permanently
    // short and re-fetches the same document forever.
    expect(built.decision.sourceDocumentId).toBe(MUNICIPAL_ROW.documentId);
    expect(
      listingIdentityKey({
        type: "document",
        sourceDocumentId: built.decision.sourceDocumentId ?? "",
      }),
    ).toBe(`document:${MUNICIPAL_ROW.documentId}`);
    // The hint the pipeline re-keys an existing null-id row by: it must be the
    // URL that row carries, which is the one this build stores as `sourceUrl`.
    expect(built.decision.legacySourceUrls).toEqual([
      built.decision.sourceUrl ?? "",
    ]);
    expect(built.decision.sourceUrl).toBe(
      `${BASE_URL}/DokumentDetail/Index/${MUNICIPAL_ROW.documentId}`,
    );
  });

  test("replays stored HTML to the same result without contacting the court", async () => {
    const payload = await listedRow();
    installStub({ search: [] });
    const built = await reconciliation.buildDecision(payload);
    if (built.type !== "built") {
      throw new TypeError("Expected the fixture decision to build");
    }
    const decision = built.decision;
    const reparse = czNssAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("Expected cz-nss to implement stored-raw replay");
    }

    globalThis.fetch = asFetchMock(() => {
      throw new TypeError("Stored-raw replay must not contact the publisher");
    });

    const stored = {
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
    } satisfies StoredRawReparseInput;
    const outcome = await reparse(stored);

    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    expect(outcome.result).toEqual(decision);
  });

  test("refuses to write a row whose document the court did not serve", async () => {
    const payload = await listedRow();
    installStub({ search: [], documentStatus: 404 });

    // Deliberately not `built`: a detail-less row would make the identity held
    // and take the document out of every later reconciliation.
    expect((await reconciliation.buildDecision(payload)).type).toBe(
      "detail-unavailable",
    );
  });

  test("a detail page the portal failed to serve is not a row without metadata", async () => {
    // The document came back but the metadata did not. Built as is, the row
    // would carry the fallback court and no ECLI for good, since the refresh
    // hashes only listing fields; reported unavailable, the walk comes back
    // for it.
    const payload = await listedRow();
    installStub({ search: [], detailStatus: 503 });

    expect((await reconciliation.buildDecision(payload)).type).toBe(
      "detail-unavailable",
    );
  });

  test("a detail page the portal has none of still builds the row", async () => {
    const payload = await listedRow();
    installStub({ search: [], detailStatus: 404 });

    const built = await reconciliation.buildDecision(payload);
    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision.ecli).toBeUndefined();
    expect(built.decision.court).toBe("Nejvyšší správní soud");
  });

  test("refuses a row that names no document at all", async () => {
    installStub({ search: [] });

    expect(
      (
        await reconciliation.buildDecision({
          caseNumber: "1 Az 4/2026",
          decisionDate: "10.06.2026",
        })
      ).type,
    ).toBe("detail-unavailable");
  });

  test("reports a payload it no longer recognises as unkeyable", async () => {
    installStub({ search: [] });

    for (const payload of [
      null,
      "1 Az 4/2026",
      { documentId: "784237" },
      { caseNumber: 4, documentId: "784237" },
      { caseNumber: "1 Az 4/2026", documentId: 784_237 },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one assertion per shape; nothing here does I/O
      expect((await reconciliation.buildDecision(payload)).type).toBe(
        "unkeyable",
      );
    }
  });

  test("the crawl keeps the row the reconciliation refuses", async () => {
    installStub({ search: [], documentStatus: 404 });
    const row = parseResultRows(rowBlock(MUNICIPAL_ROW)).at(0);
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }

    const built = await buildCzNssDecision({
      row,
      session: { cookies: "", token: "token-for-tests", formFields: new Map() },
      signal: AbortSignal.timeout(5000),
    });

    // Same call, one outcome, two dispositions: the crawl stores the decision
    // this carries, the reconciliation drops it.
    expect(built.type).toBe("detail-unavailable");
    expect(built.decision.caseNumber).toBe("1 Az 4/2026");
  });
});
