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
import { hashContent } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { publisherSummaryOf } from "@/api/lib/case-law/publisher-summary";
import {
  decodeSourceRawEnvelope,
  listingIdentityKey,
  SOURCE_DOCUMENT_ID_MAX_LENGTH,
} from "@/api/lib/legal-search/ingestion-types";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const reconciliation = requireReconciliation(czNssAdapter);

const BASE_URL = "https://vyhledavac.nssoud.cz";

/** One backslash, for fixtures that must carry a literal escape. */
const BACKSLASH = String.fromCodePoint(92);

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

/**
 * The same state for a search whose condition comes from a codelist, captured
 * verbatim from the portal. Its `ciselnikTreeData` states the condition's own
 * options as JSON inside the JSON, so each title is wrapped in an escaped
 * backslash followed by the escape for a double quote. Resolving the second
 * without consuming the first leaves text that no longer parses as JSON, and
 * the endpoint answers a body carrying it with 200 and nothing in it.
 */
const CURR_PARAMS_CODELIST_JSON =
  "[{\\u0022Id\\u0022:308,\\u0022ZobrazovanyNazevSekce\\u0022:null,\\u0022TechnickyNazev\\u0022:\\u0022pravnivetaanv\\u0022,\\u0022ZobrazovanyNazev\\u0022:\\u0022Pr\\u00E1vn\\u00ED v\\u011Bta\\u0022,\\u0022DatovyTyp\\u0022:\\u0022FIELD_DIAL\\u0022,\\u0022VazbaKDotazu\\u0022:0,\\u0022vyhledavaciPodminkaHodnota\\u0022:[{\\u0022DatovyTyp\\u0022:\\u0022FIELD_DIAL\\u0022,\\u0022TechnickyNazev\\u0022:\\u0022pravnivetaanv\\u0022,\\u0022ZobrazovanyNazev\\u0022:\\u0022Pr\\u00E1vn\\u00ED v\\u011Bta\\u0022,\\u0022HodnotaText\\u0022:null,\\u0022HodnotaCislo\\u0022:null,\\u0022HodnotaDatumACasOd\\u0022:null,\\u0022HodnotaDatumACasDo\\u0022:null,\\u0022HodnotaCiselnikPolozky\\u0022:null,\\u0022HodnotaCiselnikPolozkySelected\\u0022:\\u00228240\\u0022,\\u0022ciselnikTreeData\\u0022:\\u0022[{id:8240,title:\\\\\\u0022ano\\\\\\u0022},{id:8241,title:\\\\\\u0022ne\\\\\\u0022}]\\u0022,\\u0022ciselnikPolozky\\u0022:[],\\u0022cisPolEnum\\u0022:[],\\u0022JeNastavena\\u0022:true,\\u0022NapovedaNazev\\u0022:null,\\u0022NapovedaHtml\\u0022:null}],\\u0022Visible\\u0022:true}]";
const CURR_PARAMS_CODELIST_DECODED =
  '[{"Id":308,"ZobrazovanyNazevSekce":null,"TechnickyNazev":"pravnivetaanv","ZobrazovanyNazev":"Pr\u00e1vn\u00ed v\u011bta","DatovyTyp":"FIELD_DIAL","VazbaKDotazu":0,"vyhledavaciPodminkaHodnota":[{"DatovyTyp":"FIELD_DIAL","TechnickyNazev":"pravnivetaanv","ZobrazovanyNazev":"Pr\u00e1vn\u00ed v\u011bta","HodnotaText":null,"HodnotaCislo":null,"HodnotaDatumACasOd":null,"HodnotaDatumACasDo":null,"HodnotaCiselnikPolozky":null,"HodnotaCiselnikPolozkySelected":"8240","ciselnikTreeData":"[{id:8240,title:\\"ano\\"},{id:8241,title:\\"ne\\"}]","ciselnikPolozky":[],"cisPolEnum":[],"JeNastavena":true,"NapovedaNazev":null,"NapovedaHtml":null}],"Visible":true}]';

const scriptBlock = (params: string): string => `<script type="text/javascript">
    var moreRowsUrl = '/Home/MyResTRowsCont';
    var currParams = '${params}';
    var currViewId = '1';
    var currSort = '${CURR_SORT}';
</script>`;

type SearchPageOptions = {
  statedCount: number;
  rows: readonly RowFixture[];
  withScript?: boolean;
  /** The literal the page's own script hands its pagination state over in. */
  scriptParams?: string;
};

const searchPage = ({
  rows,
  statedCount,
  withScript = true,
  scriptParams = CURR_PARAMS_JSON,
}: SearchPageOptions): string => `<html><body>
  <div id="contenttable"><div class="col-12"><div class="row justify-content-left">
    <h6>Počet nalezených záznamů: ${statedCount}</h6>
  </div></div></div>
  <table class="infinite-scroll">${rows.map(rowBlock).join("\n")}</table>
  ${withScript ? scriptBlock(scriptParams) : ""}
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

/** What the plain-text endpoint serves where the rich one is unavailable. */
const DOCUMENT_TEXT =
  "Nejvyšší správní soud rozhodl v senátě složeném z předsedy JUDr. Karla " +
  "Šimky ve věci žalobce proti žalovanému Ministerstvu vnitra, o kasační " +
  "stížnosti žalobce proti rozsudku městského soudu, takto: Kasační stížnost " +
  "se zamítá.";

/**
 * One field of the detail page, in the portal's own markup: a `data-field-id`
 * div whose label and value are two spans told apart by their class, and
 * whose value the portal repeats in a `title` attribute.
 */
const detailField = (fieldId: string, value: string): string =>
  `<div class="col-md-12 col-lg-12 col-xl-12 detcard mt-1 d-flex justify-content-between" data-nss="nssview" data-field-id="${fieldId}">` +
  `<span class="det-textitle" data-toggle="tooltip" title="${fieldId}">${fieldId} :</span>` +
  `<span class="det-textval" data-toggle="tooltip" title="${value}"> ${value}</span></div>`;

type DetailPageOptions = {
  ecli: string;
  /**
   * The court's headnote, which the portal prints only for the decisions it
   * selects for its collection. `pravnivetaanv` states ano/ne for every
   * decision either way, so the fixture always carries both.
   */
  legalSentence?: string | undefined;
};

const detailPage = ({ ecli, legalSentence }: DetailPageOptions): string => {
  const fields = [
    detailField("ecli", ecli),
    detailField("druhdokumentuavyrokrozhodnuti", "Rozsudek"),
    detailField("datumvydanirozhodnuti", "10.06.2026"),
    ...(legalSentence === undefined
      ? []
      : [detailField("pravnivetaupravena", legalSentence)]),
    detailField("pravnivetaanv", legalSentence === undefined ? "ne" : "ano"),
  ].join("");
  return `<html><body>${fields}</body></html>`;
};

// ── Fetch stub ───────────────────────────────────────────

type RecordedRequest = { method: string; url: string; body: string };

type StubOptions = {
  /** Search responses, one per POST /Home/Index, last one repeats. */
  search?: readonly Response[];
  /** Continuation responses, one per POST /Home/MyResTRowsCont. */
  continuation?: readonly Response[];
  /** Status for both document endpoints; 200 serves the fixture. */
  documentStatus?: number;
  /** Status for the rich HTML document alone; defaults to `documentStatus`. */
  htmlDocumentStatus?: number;
  /** Status for the detail page alone; defaults to `documentStatus`. */
  detailStatus?: number;
  /** The headnote the detail page states, if the court wrote one. */
  legalSentence?: string | undefined;
};

const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

/** The plain-text endpoint serves UTF-16, which is what the adapter decodes. */
const utf16Response = (body: string): Response =>
  new Response(Buffer.from(body, "utf16le"));

const installStub = ({
  continuation = [],
  documentStatus = 200,
  detailStatus = documentStatus,
  htmlDocumentStatus = documentStatus,
  legalSentence,
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
            ? htmlResponse(
                detailPage({
                  ecli: "ECLI:CZ:MSPH:2026:1.Az.4.2026.79",
                  legalSentence,
                }),
              )
            : htmlResponse("", detailStatus);
        }
        if (url.pathname.startsWith("/DokumentOriginal/Html/")) {
          return htmlDocumentStatus === 200
            ? htmlResponse(DOCUMENT_HTML)
            : htmlResponse("", htmlDocumentStatus);
        }
        if (url.pathname.startsWith("/DokumentOriginal/Text/")) {
          return documentStatus === 200
            ? utf16Response(DOCUMENT_TEXT)
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
    expect(reconciliation.firstSlice).toBe(CZ_NSS_FIRST_SLICE);
    expect(CZ_NSS_FIRST_SLICE).toBe("2003-02-04");
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
    // The sheet number comes off the docket, because a citation names the
    // docket alone, and is kept beside it rather than dropped.
    expect(rows.at(0)?.caseNumber).toBe("1 Az 4/2026");
    expect(rows.at(0)?.publishedCaseNumber).toBe("1 Az 4/2026-79");
    expect(rows.at(0)?.documentId).toBe("784237");
    expect(rows.at(0)?.documentUrl).toBe(
      `${BASE_URL}/DokumentDetail/Index/784237`,
    );
    expect(rows.at(0)?.decisionDate).toBe("10.06.2026");
  });

  test("reads a docket the citation spaces off its sheet number", () => {
    // The portal's citations are tight, its documents spaced; both forms name
    // one case, so both have to reduce to one docket.
    const rows = parseResultRows(
      rowBlock({ ...MUNICIPAL_ROW, citedCaseNumber: "1 Az 4/2026 - 79" }),
    );

    expect(rows.at(0)?.caseNumber).toBe("1 Az 4/2026");
    expect(rows.at(0)?.publishedCaseNumber).toBe("1 Az 4/2026 - 79");
  });

  test("keeps a docket the citation states with no sheet number", () => {
    const rows = parseResultRows(
      rowBlock({ ...MUNICIPAL_ROW, citedCaseNumber: "1 Az 4/2026" }),
    );

    expect(rows.at(0)?.caseNumber).toBe("1 Az 4/2026");
    expect(rows.at(0)?.publishedCaseNumber).toBe("1 Az 4/2026");
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
      publishedCaseNumber: undefined,
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
      // Parked with the row, because the sheet is only recoverable from the
      // reference as published and the build runs days after the listing.
      publishedCaseNumber: "1 Az 4/2026-79",
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

    const error = await rejectionOf(
      reconciliation.listSlicePage({ slice: SLICE, page: 1 }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("answered no rows for page 1");
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
    // The date-range condition carries no nested quoting, so this is the byte
    // string the endpoint has always been posted, unchanged.
    expect(body.get("zobrazeniVysledkuId")).toBe("1");
    expect(body.get("pageNum")).toBe("1");
    expect(body.get("resultOrder")).toBe(CURR_SORT);
    expect(listed.items.map(({ identity }) => identity)).toEqual([
      { type: "document", sourceDocumentId: REGIONAL_ROW.documentId },
    ]);
  });

  test("a codelist condition reaches the endpoint as the JSON the portal wrote", async () => {
    const { requests } = installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: CZ_NSS_FIRST_PAGE_ROWS + 1,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
            scriptParams: CURR_PARAMS_CODELIST_JSON,
          }),
        ),
      ],
      continuation: [htmlResponse(rowBlock(REGIONAL_ROW))],
    });

    await reconciliation.listSlicePage({ slice: SLICE, page: 1 });

    const posted = new URLSearchParams(requests.at(-1)?.body ?? "").get(
      "vyhledavaciPodminky",
    );
    expect(posted).toBe(CURR_PARAMS_CODELIST_DECODED);
    // The endpoint reconstructs the search by parsing this, so the assertion
    // that matters is not the byte string but that it is still JSON: the
    // escaped backslashes around each codelist title are exactly what a
    // reader resolving `\\uXXXX` on its own destroys.
    expect(() => JSON.parse(posted ?? "")).not.toThrow();
  });

  test("a literal ending at an escaped apostrophe is not truncated", async () => {
    // The portal quotes these literals with apostrophes, so a value holding
    // one escapes it. Ending the literal at any apostrophe posts a prefix of
    // the query, which the endpoint does not recognise.
    const { requests } = installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: CZ_NSS_FIRST_PAGE_ROWS + 1,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
            scriptParams: `[{${BACKSLASH}u0022Nazev${BACKSLASH}u0022:${BACKSLASH}u0022d${BACKSLASH}'Artagnan${BACKSLASH}u0022}]`,
          }),
        ),
      ],
      continuation: [htmlResponse(rowBlock(REGIONAL_ROW))],
    });

    await reconciliation.listSlicePage({ slice: SLICE, page: 1 });

    expect(
      new URLSearchParams(requests.at(-1)?.body ?? "").get(
        "vyhledavaciPodminky",
      ),
    ).toBe('[{"Nazev":"d\'Artagnan"}]');
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

  test("an empty continuation body fails the page instead of ending the day", async () => {
    // Case-law rule 14. The crawl read a 200 with no body as "no more rows",
    // moved its cursor to the next day and never came back, so a query the
    // endpoint refused cost the whole day past its first page. Failing holds
    // the cursor and retries the page.
    installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: 68,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
      ],
      continuation: [htmlResponse("")],
    });

    const page = await czNssAdapter.fetchPage(`${SLICE}:1`, {});

    expect(Result.isError(page)).toBe(true);
  }, 30_000);

  test("a page past the day's last record is allowed to come back empty", async () => {
    // The same empty body, and this time it is the answer: the day states
    // sixty records, the first two pages carry all of them, and page two is
    // past the end. Refusing this would wedge every day whose record count
    // lands on a page boundary.
    installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: CZ_NSS_FIRST_PAGE_ROWS + CZ_NSS_CONTINUATION_PAGE_ROWS,
            rows: fullPageRows(CZ_NSS_FIRST_PAGE_ROWS),
          }),
        ),
      ],
      continuation: [htmlResponse("")],
    });

    const page = await czNssAdapter.fetchPage(`${SLICE}:2`, {});

    expect(Result.isError(page)).toBe(false);
  }, 30_000);
});

// ── Per-item build ───────────────────────────────────────

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

  /** Crawl one decision whose citation states the reference given. */
  const crawledWithCitation = async (citedCaseNumber: string) => {
    installStub({
      search: [
        htmlResponse(
          searchPage({
            statedCount: 1,
            rows: [{ ...MUNICIPAL_ROW, citedCaseNumber }],
          }),
        ),
      ],
    });
    const listed = await reconciliation.listSlicePage({
      slice: SLICE,
      page: 0,
    });
    installStub({ search: [] });
    const built = await reconciliation.buildDecision(
      throughJsonb(listed.items.at(0)?.payload),
    );
    if (built.type !== "built") {
      throw new TypeError("Expected the fixture decision to build");
    }
    return built.decision;
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
    // The sheet is stored beside the docket, with the reference as published,
    // so nothing has to guess how the court set the two together.
    expect(built.decision.sheetNumber).toBe("79");
    expect(built.decision.metadata["publishedCaseNumber"]).toBe(
      "1 Az 4/2026-79",
    );
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

  test("a payload parked before the sheet was kept still builds", async () => {
    // Rows the loop parked under an older parser carry no published
    // reference. They build with the sheet they were listed with, which is
    // none, rather than being refused for a field they could not have stated.
    const legacy: ParsedRow = {
      caseNumber: "1 Az 4/2026",
      publishedCaseNumber: undefined,
      decisionDate: "10.06.2026",
      decisionType: undefined,
      outcome: undefined,
      documentUrl: `${BASE_URL}/DokumentDetail/Index/${MUNICIPAL_ROW.documentId}`,
      documentId: MUNICIPAL_ROW.documentId,
    };
    installStub({ search: [] });

    const built = await reconciliation.buildDecision(throughJsonb(legacy));

    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision.caseNumber).toBe("1 Az 4/2026");
    expect(built.decision.sheetNumber).toBeUndefined();
    expect(built.decision.metadata["publishedCaseNumber"]).toBe("1 Az 4/2026");
  });

  /**
   * The refresh check skips a row whose source hash stands still, so a row
   * stored before the sheet was read has to hash differently once its listing
   * states one. Without this the recovered sheet never reaches the row.
   */
  test("a citation that states a sheet number moves the source hash", async () => {
    const withSheet = await crawledWithCitation("1 Az 4/2026-79");
    const withoutSheet = await crawledWithCitation("1 Az 4/2026");

    expect(withSheet.sheetNumber).toBe("79");
    expect(withoutSheet.sheetNumber).toBeUndefined();
    expect(withSheet.rawHash).not.toBe(withoutSheet.rawHash);
  });

  /**
   * The other half of that bargain: a row the court states no sheet for gains
   * nothing from this change and must not be rewritten for it. The literal is
   * the hash's pre-existing input, so re-hashing the sheetless corpus cannot
   * happen without editing this line.
   */
  test("a citation with no sheet number hashes as it did before", async () => {
    const decision = await crawledWithCitation("1 Az 4/2026");

    expect(decision.rawHash).toBe(
      hashContent("1 Az 4/2026|2026-06-10|rozsudek"),
    );
  });

  test("the court's spacing does not move the source hash", async () => {
    const tight = await crawledWithCitation("1 Az 4/2026-79");
    const spaced = await crawledWithCitation("1 Az 4/2026 - 79");

    // Spacing is typography, not the document moving. Were it hashed, a court
    // re-spacing its citations would rewrite its whole corpus, and a legacy
    // row would never agree with the crawl that re-reads it.
    expect(spaced.rawHash).toBe(tight.rawHash);
    expect(spaced.metadata["publishedCaseNumber"]).toBe("1 Az 4/2026 - 79");
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
    // Named as well as covered by the equality above: the replay reads the
    // sheet back off the stored reference, and a replay that dropped it would
    // clear the column on every row it touched.
    expect(outcome.result.sheetNumber).toBe("79");
  });

  /** Replay one stored row, stated as the database holds it. */
  const replayStored = async ({
    caseNumber,
    metadata,
  }: {
    caseNumber: string;
    metadata: Record<string, unknown>;
  }) => {
    const decision = await crawledWithCitation("1 Az 4/2026-79");
    const reparse = czNssAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("Expected cz-nss to implement stored-raw replay");
    }
    globalThis.fetch = asFetchMock(() => {
      throw new TypeError("Stored-raw replay must not contact the publisher");
    });

    const outcome = await reparse({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: decision.sourceRawContentType ?? null,
      caseNumber,
      sourceDocumentId: decision.sourceDocumentId ?? null,
      language: decision.language,
      court: decision.court,
      ecli: decision.ecli ?? null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata,
    } satisfies StoredRawReparseInput);

    return { crawled: decision, outcome };
  };

  /**
   * The shape the backfill leaves a legacy row in: the docket in its own
   * column, the sheet in its own, and the reference as the court published it
   * surviving nowhere but the metadata the older ingest wrote.
   */
  test("a replay recovers the published reference a legacy row keeps in metadata", async () => {
    const { crawled, outcome } = await replayStored({
      caseNumber: "1 Az 4/2026",
      metadata: { caseNumber: "1 Az 4/2026 - 79" },
    });

    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    expect(outcome.result.sheetNumber).toBe("79");
    expect(outcome.result.metadata["publishedCaseNumber"]).toBe(
      "1 Az 4/2026 - 79",
    );
    // The reference is stored as the court set it, spacing and all, and the
    // row still hashes as the crawl that re-reads it would hash it.
    expect(outcome.result.rawHash).toBe(crawled.rawHash);
  });

  test("a replay reads the sheet off a legacy row the backfill has not reached", async () => {
    const { outcome } = await replayStored({
      caseNumber: "1 Az 4/2026 - 79",
      metadata: { caseNumber: "1 Az 4/2026 - 79" },
    });

    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    // The case number is left exactly as stored: the replay's identity check
    // compares it against the row, and the backfill owns that rewrite.
    expect(outcome.result.caseNumber).toBe("1 Az 4/2026 - 79");
    expect(outcome.result.sheetNumber).toBe("79");
  });

  test("a replay leaves a metadata reference naming another case alone", async () => {
    const { outcome } = await replayStored({
      caseNumber: "1 Az 4/2026",
      metadata: { caseNumber: "9 As 9/2026-12" },
    });

    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    // Metadata is the publisher's, not ours: a field naming another docket
    // buys this row no sheet.
    expect(outcome.result.sheetNumber).toBeUndefined();
    expect(outcome.result.metadata["publishedCaseNumber"]).toBe("1 Az 4/2026");
  });

  /** The court's own words, as it writes them under `Právní věta (text)`. */
  const HEADNOTE =
    "Rozhodnutí v místním referendu, která jsou ze zákona neplatná " +
    "(§ 48 odst. 1 zákona č. 22/2004 Sb., o místním referendu), správní soudy " +
    "z hlediska dalších vad způsobujících neplatnost rozhodnutí nepřezkoumávají.";

  /** Crawl one decision the portal states this headnote for, or none. */
  const crawledWithHeadnote = async (legalSentence?: string) => {
    installStub({
      legalSentence,
      search: [
        htmlResponse(searchPage({ statedCount: 1, rows: [MUNICIPAL_ROW] })),
      ],
    });
    const listed = await reconciliation.listSlicePage({
      slice: SLICE,
      page: 0,
    });
    installStub({ legalSentence, search: [] });
    const built = await reconciliation.buildDecision(
      throughJsonb(listed.items.at(0)?.payload),
    );
    if (built.type !== "built") {
      throw new TypeError("Expected the fixture decision to build");
    }
    return built.decision;
  };

  test("the court's headnote reaches the row's publisher summary", async () => {
    const decision = await crawledWithHeadnote(HEADNOTE);

    expect(decision.metadata["legalSentence"]).toBe(HEADNOTE);
    // The key is worth writing only where the summary reader looks, so the
    // reader answers here rather than the spelling being trusted on its own.
    expect(
      publisherSummaryOf({ documentAst: null, metadata: decision.metadata }),
    ).toBe(HEADNOTE);
  });

  test("the ano/ne flag beside the headnote is not the headnote", async () => {
    const withHeadnote = await crawledWithHeadnote(HEADNOTE);
    const without = await crawledWithHeadnote();

    // `pravnivetaanv` states ano/ne for every decision and sits beside
    // `pravnivetaupravena`; a reader keyed on the shared prefix would store
    // "ne" as the sentence for the whole corpus.
    expect(withHeadnote.metadata["legalSentence"]).toBe(HEADNOTE);
    expect(without.metadata["legalSentence"]).toBeUndefined();
    expect(
      publisherSummaryOf({ documentAst: null, metadata: without.metadata }),
    ).not.toBe("ne");
  });

  test("a replay reads the headnote back off the stored detail page", async () => {
    const decision = await crawledWithHeadnote(HEADNOTE);
    const reparse = czNssAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("Expected cz-nss to implement stored-raw replay");
    }
    globalThis.fetch = asFetchMock(() => {
      throw new TypeError("Stored-raw replay must not contact the publisher");
    });

    const replayed = async (
      stored: Pick<StoredRawReparseInput, "raw" | "contentType" | "metadata">,
    ) =>
      await reparse({
        ...stored,
        caseNumber: decision.caseNumber,
        sourceDocumentId: decision.sourceDocumentId ?? null,
        language: decision.language,
        court: decision.court,
        ecli: decision.ecli ?? null,
        decisionDate: decision.decisionDate ?? null,
        decisionType: decision.decisionType ?? null,
        sourceUrl: decision.sourceUrl ?? null,
        documentUrl: decision.documentUrl ?? null,
      } satisfies StoredRawReparseInput);

    // The row as stored today: both pages the crawl fetched. The headnote is
    // on the detail page, so a replay recovers it even for a row written
    // before anything read that field.
    const { legalSentence: _unread, ...beforeCapture } = decision.metadata;
    const recovered = await replayed({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: decision.sourceRawContentType ?? null,
      metadata: beforeCapture,
    });

    // A row stored before the raw held every page carries the document alone,
    // and the sentence is on neither document endpoint. Only a re-crawl adds
    // it there.
    const legacy = await replayed({
      raw: new TextEncoder().encode(DOCUMENT_HTML),
      contentType: "text/html",
      metadata: beforeCapture,
    });

    expect(recovered.type).toBe("parsed");
    expect(legacy.type).toBe("parsed");
    if (recovered.type !== "parsed" || legacy.type !== "parsed") {
      return;
    }
    expect(recovered.result.metadata["legalSentence"]).toBe(HEADNOTE);
    expect(legacy.result.metadata["legalSentence"]).toBeUndefined();
    // Crawl and replay have to agree on the hash, or every replayed row would
    // read as changed to the crawl that next re-reads it, and back again. For
    // a row whose metadata never read the sentence, the stored detail page is
    // what brings the two back into agreement.
    expect(recovered.result.rawHash).toBe(decision.rawHash);
    expect(legacy.result.rawHash).not.toBe(decision.rawHash);
  });

  test("a headnote the court adds or edits moves the source hash", async () => {
    const none = await crawledWithHeadnote();
    const headnoted = await crawledWithHeadnote(HEADNOTE);
    const edited = await crawledWithHeadnote(`${HEADNOTE} Věta druhá.`);

    // The refresh check skips a row whose source hash stands still. The court
    // writes its headnote after publishing the decision and edits it later,
    // so a row stored before either has to hash differently once the portal
    // states the new text; otherwise the update never lands.
    expect(headnoted.rawHash).not.toBe(none.rawHash);
    expect(edited.rawHash).not.toBe(headnoted.rawHash);
  });

  test("a decision the court states no headnote for hashes as it did before", async () => {
    const none = await crawledWithHeadnote();

    // The literal is the hash's pre-existing input, so re-hashing the rows the
    // court wrote no headnote for cannot happen without editing this line.
    expect(none.rawHash).toBe(
      hashContent("1 Az 4/2026-79|2026-06-10|rozsudek"),
    );
  });

  test("a row built from the text endpoint still stores what was fetched", async () => {
    const payload = await listedRow();
    // The portal serves the rich document for most decisions and the plain
    // text for the rest; the fallback row used to keep neither response.
    installStub({ search: [], htmlDocumentStatus: 404 });
    const built = await reconciliation.buildDecision(payload);
    if (built.type !== "built") {
      throw new TypeError("Expected the text fallback to build a decision");
    }

    const parts = decodeSourceRawEnvelope(built.decision.sourceRaw ?? "");
    expect(built.decision.fulltext).toContain("Kasační stížnost");
    expect(Object.keys(parts ?? {}).toSorted()).toEqual(["detail", "text"]);
  });

  test("a replay rebuilds the text-served row the crawl built", async () => {
    const payload = await listedRow();
    installStub({ search: [], htmlDocumentStatus: 404 });
    const built = await reconciliation.buildDecision(payload);
    if (built.type !== "built") {
      throw new TypeError("Expected the text fallback to build a decision");
    }
    const reparse = czNssAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("Expected cz-nss to implement stored-raw replay");
    }
    globalThis.fetch = asFetchMock(() => {
      throw new TypeError("Stored-raw replay must not contact the publisher");
    });

    const outcome = await reparse({
      raw: new TextEncoder().encode(built.decision.sourceRaw ?? ""),
      contentType: built.decision.sourceRawContentType ?? null,
      caseNumber: built.decision.caseNumber,
      sourceDocumentId: built.decision.sourceDocumentId ?? null,
      language: built.decision.language,
      court: built.decision.court,
      ecli: built.decision.ecli ?? null,
      decisionDate: built.decision.decisionDate ?? null,
      decisionType: built.decision.decisionType ?? null,
      sourceUrl: built.decision.sourceUrl ?? null,
      documentUrl: built.decision.documentUrl ?? null,
      metadata: built.decision.metadata,
    } satisfies StoredRawReparseInput);

    // The portal served this decision as plain text, and that is the document
    // the row was stored on. A replay that read only the rich part would
    // report it as having none and leave the row behind.
    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    expect(outcome.result.fulltext).toBe(built.decision.fulltext);
    expect(outcome.result.documentAst).toEqual(built.decision.documentAst);
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
