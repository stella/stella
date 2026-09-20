/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  czUsAdapter,
  parseNalusDetail,
  RESULTS_PAGE_SIZE,
} from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import { NalusRateLimitedError } from "@/api/handlers/case-law/ingestion/adapters/cz-us-throttle";
import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

type ResultRow = {
  id?: string | undefined;
  sz: string;
  caseNumber: string;
  listedCaseNumber?: string | undefined;
  listedCounter?: string | null | undefined;
  date: string;
  ecli?: string | undefined;
  textUrl?: string | null | undefined;
  textActionLabel?: string | undefined;
};

/**
 * The page sizes the court's form renders, and the only ones it accepts back.
 *
 * Read off the mock's own form rather than declared beside it, so the two
 * cannot state different sets: the submit below validates against whatever
 * this page offered, the way the court's WebForms event validation does.
 */
const offeredPageSizes = (form: string): string[] =>
  [...form.matchAll(/<option\b[^>]*\bvalue="(?<size>\d+)"/gu)].map(
    ({ groups }) => groups?.["size"] ?? "",
  );

const makeSearchForm = (): string => `
<html><body>
  <input id="__VIEWSTATE" value="view-state" />
  <input id="__VIEWSTATEGENERATOR" value="generator" />
  <input id="__EVENTVALIDATION" value="validation" />
  <select name="ctl00$MainContent$resultsPageSize" id="ctl00_MainContent_resultsPageSize">
    <option value="10">10</option>
    <option selected="selected" value="20">20</option>
    <option value="40">40</option>
    <option value="80">80</option>
  </select>
</body></html>`;

/**
 * What the court answers a submit it refused: the results page is still
 * served, and it carries no results.
 */
const makeRefusedResultsPage = (): string =>
  '<html><body><div id="ctl00_MainContent_pnlResults"></div></body></html>';

const makeNoResultsPage = (): string => `
<html><body>
  <span id="ctl00_MainContent_lbError" class="labelError">
    Pro zadaná kritéria nebyly nalezeny žádné záznamy.
  </span>
  <input id="ctl00_bResults" disabled="disabled" />
</body></html>`;

const makeTextPage = (
  caseNumber: string,
  date: string,
  fields: {
    decisionForm?: string;
    parallelQuotation?: string;
    popularName?: string;
    counter?: number | string;
  } = {},
): string => `
<html><body>
  <span id="lblRegistrySign">${caseNumber} ze dne ${date}</span>
  <span id="lblDecisionForm">${fields.decisionForm ?? "Nález"}</span>
  <span id="lblParallelQuotation">${fields.parallelQuotation ?? ""}</span>
  <span id="lblPopularName">${fields.popularName ?? ""}</span>
  <input name="registrySignHidden" value="${caseNumber}${
    fields.counter === undefined ? "" : ` #${fields.counter}`
  } ze dne ${date}" />
  <table class="DocContent"><tr><td>
    ${"Lorem ipsum dolor sit amet. ".repeat(10)}
    Jan Novák (soudce zpravodaj)
  </td></tr></table>
</body></html>`;

/** The labelled record card ResultDetail.aspx prints beside the document. */
const makeRecordCardPage = (
  caseNumber: string,
  date: string,
  {
    rapporteur = "Nováková Jana",
    dissenters = [],
    decisionForm = "Nález",
  }: {
    rapporteur?: string;
    dissenters?: readonly string[];
    decisionForm?: string;
  } = {},
): string => `
<html><body>
  <table id="tableDocumentHeader"><tr><td>Soudce zpravodaj</td></tr></table>
  <table class='recordCardTable'>
    <tr><td>Spisová značka</td><td>${caseNumber}</td></tr>
    <tr><td>Datum rozhodnutí</td><td>${date}</td></tr>
    <tr><td>Forma rozhodnutí</td><td>${decisionForm}</td></tr>
    <tr><td>Typ řízení</td><td>O ústavních stížnostech</td></tr>
    <tr><td>Navrhovatel</td><td>STĚŽOVATEL - FO</td></tr>
    <tr><td>Soudce zpravodaj</td><td>${rapporteur}</td></tr>
    <tr><td>Odlišné stanovisko</td><td>${dissenters.join("<br/>")}</td></tr>
    <tr><td>Věcný rejstřík</td><td>žaloba<br/>lhůta</td></tr>
    <tr><td>Poznámka</td><td>&nbsp;</td></tr>
  </table>
</body></html>`;

const makeAbstractPage = (abstract = "", legalSentence = ""): string => `
<html><body>
  <table class="abstractContent"><tr><td>${abstract}</td></tr></table>
  <table class="legalSentenceContent"><tr><td>${legalSentence}</td></tr></table>
</body></html>`;

const makeResultsPage = (
  rows: readonly ResultRow[],
  rangeFrom: number,
  reported: number,
  renderPositionOffset = 0,
): string => {
  const rangeTo = rangeFrom + rows.length - 1;
  const body = rows
    .map((row, index) => {
      const counter = /_(?<counter>\d+)$/u.exec(row.sz)?.groups?.["counter"];
      const textUrl =
        row.textUrl === undefined
          ? `https://nalus.usoud.cz:443/Search/GetText.aspx?sz=${row.sz}`
          : row.textUrl;
      const detailUrl =
        row.id === undefined
          ? `ResultDetail.aspx?malformed=true&pos=${rangeFrom + index + renderPositionOffset}&cnt=${reported}`
          : `ResultDetail.aspx?id=${row.id}&pos=${rangeFrom + index + renderPositionOffset}&cnt=${reported}&typ=result`;
      const counterLabel =
        row.listedCounter === null
          ? ""
          : ` #${row.listedCounter ?? counter ?? "1"}`;
      let textAction = "";
      if (textUrl) {
        textAction =
          row.textActionLabel === undefined
            ? `<img onclick='javascript:ShowLink("${textUrl}", "Odkaz", "")' />`
            : `<a onclick='javascript:ShowLink("${textUrl}", "Odkaz", "")'>${row.textActionLabel}</a>`;
      }
      return `
<tr class='resultData${(index + renderPositionOffset) % 2}'>
  <td></td>
  <td><a href='${detailUrl}'>${row.listedCaseNumber ?? row.caseNumber}${counterLabel}</a><br />${row.ecli ?? ""}<br />Jan Novák</td>
</tr>
<tr class='resultData${(index + renderPositionOffset) % 2}' valign="top">
  <td>${textAction}</td>
</tr>`;
    })
    .join("");
  const banner = `Výsledky ${rangeFrom} - ${rangeTo} z celkem ${reported}`;
  return `<html><body>${banner}<table>${body}</table>${banner}</body></html>`;
};

const resolveUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

const requestMethod = (
  input: string | URL | Request,
  init?: RequestInit,
): string => init?.method ?? (input instanceof Request ? input.method : "GET");

const unwrap = <T>(result: Result<T, unknown>): T => {
  expect(Result.isOk(result)).toBe(true);
  if (!Result.isOk(result)) {
    throw result.error;
  }
  return result.value;
};

type MockSearchOptions = {
  rows?: readonly ResultRow[];
  rangeFrom?: number;
  reported?: number;
  empty?: boolean;
  abstract?: string;
  legalSentence?: string;
  abstractStatus?: number;
  detailStatus?: number;
  /** The rapporteur every record card in this run names. */
  rapporteur?: string;
  /** The dissenters every record card in this run names, as printed. */
  dissenters?: readonly string[];
  /** Answer every record-card request with this status instead of 200. */
  recordCardStatus?: number;
  unparseableDetail?: boolean;
  renderPositionOffset?: number;
  /** Where the search submit's 302 points, when not the results page. */
  submitLocation?: string;
  onPost?: (form: URLSearchParams, headers: Headers) => void;
  onDetail?: (url: URL, init?: RequestInit) => void;
};

/**
 * Requests the adapter made to the court. Counted rather than inferred: the
 * publisher caps automated clients at a fixed number of requests a day, so
 * what a cycle costs is part of this adapter's contract.
 */
let nalusRequests = 0;

const fetchCallCount = (): number => nalusRequests;

const installRawMock = (
  respond: (input: string | URL | Request) => Response,
): void => {
  nalusRequests = 0;
  globalThis.fetch = asFetchMock(
    mock((input: string | URL | Request) => {
      nalusRequests += 1;
      return Promise.resolve(respond(input));
    }),
  );
};

/** Answers every NALUS request with a 302 to `location`, followed by nothing. */
const installRedirectMock = (location: string): void => {
  installRawMock(
    () => new Response(null, { status: 302, headers: { Location: location } }),
  );
};

let searchRefused = false;

const installSearchMock = ({
  rows = [],
  rangeFrom = 1,
  reported = rows.length,
  empty = false,
  abstract = "",
  legalSentence = "",
  abstractStatus = 200,
  detailStatus = 200,
  rapporteur = "Nováková Jana",
  dissenters = [],
  recordCardStatus = 200,
  unparseableDetail = false,
  renderPositionOffset = 0,
  submitLocation = "/Search/Results.aspx",
  onPost,
  onDetail,
}: MockSearchOptions): void => {
  const bySz = new Map(rows.map((row) => [row.sz, row]));
  nalusRequests = 0;
  searchRefused = false;
  globalThis.fetch = asFetchMock(
    mock((input: string | URL | Request, init?: RequestInit) => {
      nalusRequests += 1;
      const url = new URL(resolveUrl(input));
      const method = requestMethod(input, init);
      if (url.pathname.endsWith("/Search/Search.aspx") && method === "GET") {
        return Promise.resolve(
          new Response(makeSearchForm(), {
            headers: { "Set-Cookie": "ASP.NET_SessionId=test-session; Path=/" },
          }),
        );
      }
      if (url.pathname.endsWith("/Search/Search.aspx") && method === "POST") {
        const form = new URLSearchParams(
          typeof init?.body === "string" ? init.body : "",
        );
        onPost?.(form, new Headers(init?.headers));
        // The court validates the submitted page size against the options it
        // rendered and redirects a submit carrying any other value to its
        // error page, so a size outside the form's own set never reaches a
        // result set here either.
        searchRefused = !offeredPageSizes(makeSearchForm()).includes(
          form.get("ctl00$MainContent$resultsPageSize") ?? "",
        );
        if (searchRefused) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { Location: "/Error.aspx" },
            }),
          );
        }
        return Promise.resolve(
          empty
            ? new Response(makeNoResultsPage())
            : new Response(null, {
                status: 302,
                headers: { Location: submitLocation },
              }),
        );
      }
      if (url.pathname.endsWith("/Search/Results.aspx")) {
        return Promise.resolve(
          new Response(
            searchRefused
              ? makeRefusedResultsPage()
              : makeResultsPage(
                  rows,
                  rangeFrom,
                  reported,
                  renderPositionOffset,
                ),
          ),
        );
      }
      if (url.pathname.endsWith("/Search/GetText.aspx")) {
        onDetail?.(url, init);
        const row = bySz.get(url.searchParams.get("sz") ?? "");
        const counterText =
          row === undefined
            ? undefined
            : /_(?<counter>\d+)$/u.exec(row.sz)?.groups?.["counter"];
        return Promise.resolve(
          row
            ? new Response(
                unparseableDetail
                  ? "<html><body>detail unavailable</body></html>"
                  : makeTextPage(
                      row.caseNumber,
                      row.date,
                      counterText === undefined ? {} : { counter: counterText },
                    ),
                { status: detailStatus },
              )
            : new Response("missing", { status: 404 }),
        );
      }
      if (url.pathname.endsWith("/Search/ResultDetail.aspx")) {
        const row = rows.find(
          (candidate) => candidate.id === url.searchParams.get("id"),
        );
        return Promise.resolve(
          row && recordCardStatus === 200
            ? new Response(
                makeRecordCardPage(row.caseNumber, row.date, {
                  rapporteur,
                  dissenters,
                }),
              )
            : new Response("no card", {
                status: recordCardStatus === 200 ? 404 : recordCardStatus,
              }),
        );
      }
      if (url.pathname.endsWith("/Search/GetAbstract.aspx")) {
        return Promise.resolve(
          new Response(makeAbstractPage(abstract, legalSentence), {
            status: abstractStatus,
          }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    }),
  );
};

const latestClosedAvailabilityDay = (): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

const czechDay = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`);
  return `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;
};

const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const historicalCursor = (
  year: number,
  availableTo = latestClosedAvailabilityDay(),
): string => `search:historical:${availableTo}:${year}:collect:0:0:-`;

const recentCursor = (verifiedThrough: string, availableTo: string): string =>
  `search:recent-frontier:${verifiedThrough}:${availableTo}:collect:0:0:-`;

describe("czUsAdapter.fetchPage", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  beforeAll(() => {
    setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
  });

  afterAll(() => {
    setSystemTime();
  });

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test("enumerates exact historical identifiers across chambers and plenary dockets", async () => {
    const rows = [
      {
        id: "1001",
        sz: "1-1-1993",
        caseNumber: "I.ÚS 1/1993",
        date: "1. 3. 1993",
      },
      {
        id: "1002",
        sz: "2-1-1993",
        caseNumber: "II.ÚS 1/1993",
        date: "2. 3. 1993",
      },
      {
        id: "1003",
        sz: "Pl-1-1993",
        caseNumber: "Pl.ÚS 1/1993",
        date: "3. 3. 1993",
      },
    ];
    let submitted: URLSearchParams | undefined;
    installSearchMock({
      rows,
      onPost: (form, headers) => {
        submitted = form;
        expect(headers.get("Cookie")).toContain(
          "ASP.NET_SessionId=test-session",
        );
      },
    });

    const page = unwrap(await czUsAdapter.fetchPage(null, {}));

    expect(submitted?.get("ctl00$MainContent$decidedFrom")).toBe("1.1.1993");
    expect(submitted?.get("ctl00$MainContent$decidedTo")).toBe("31.12.1993");
    expect(submitted?.get("ctl00$MainContent$availableFrom")).toBe("1.1.1900");
    expect(submitted?.get("ctl00$MainContent$availableTo")).toBe(
      czechDay(latestClosedAvailabilityDay()),
    );
    expect(submitted?.get("ctl00$MainContent$resultsPageSize")).toBe(
      String(RESULTS_PAGE_SIZE),
    );
    expect(page.decisions.map(({ caseNumber }) => caseNumber)).toEqual(
      rows.map(({ caseNumber }) => caseNumber),
    );
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["nalus-record:1001", "nalus-record:1002", "nalus-record:1003"]);
    expect(page.nextCursor).toMatch(
      /^search:historical:2026-08-07:1993:verify:0:0:[a-f0-9]+$/u,
    );

    const verified = unwrap(await czUsAdapter.fetchPage(page.nextCursor, {}));
    expect(verified.nextCursor).toBe(historicalCursor(1994));
  });

  test("asks the search form for a page size it offers", async () => {
    let submitted: URLSearchParams | undefined;
    installSearchMock({
      rows: [{ sz: "1-1-93_1", caseNumber: "I.ÚS 1/93", date: "1. 1. 1993" }],
      onPost: (form) => {
        submitted = form;
      },
    });

    // The court refuses a size it did not render, and the refusal reaches the
    // crawl as a results page with no count banner on it, so a page read here
    // at all is what proves the size was one the form offers.
    const page = unwrap(await czUsAdapter.fetchPage(null, {}));

    // Every rendered option, so a size the court offers cannot go missing from
    // the set the submit above is judged against — `selected` precedes `value`
    // on one of them, which a laxer read of the form drops.
    expect(offeredPageSizes(makeSearchForm())).toEqual([
      "10",
      "20",
      "40",
      "80",
    ]);
    expect(offeredPageSizes(makeSearchForm())).toContain(
      submitted?.get("ctl00$MainContent$resultsPageSize") ?? "",
    );
    expect(page.decisions).toHaveLength(1);
  });

  test("names the results listing, not the session bootstrap, as its source", async () => {
    installSearchMock({
      rows: [
        {
          id: "1001",
          sz: "1-1-1993",
          caseNumber: "I.ÚS 1/1993",
          date: "1. 3. 1993",
        },
      ],
    });

    const page = unwrap(await czUsAdapter.fetchPage(null, {}));

    // The first request of this handshake fetches the WebForms state from
    // Search.aspx and carries no decision; the rows come from Results.aspx.
    expect(page.sourceUrl).toBe("https://nalus.usoud.cz/Search/Results.aspx");
  });

  test("keeps multiple published decisions under one docket distinct", async () => {
    const rows = [
      {
        id: "2001",
        sz: "I-42-24_1",
        caseNumber: "I.ÚS 42/24",
        date: "1. 2. 2024",
        ecli: "ECLI:CZ:US:2024:1.US.42.24.1",
      },
      {
        id: "2002",
        sz: "1-42-24_2",
        caseNumber: "I.ÚS 42/24",
        date: "1. 2. 2024",
        ecli: "ECLI:CZ:US:2024:1.US.42.24.2",
      },
    ];
    installSearchMock({ rows });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(page.decisions.map(({ caseNumber }) => caseNumber)).toEqual([
      "I.ÚS 42/24",
      "I.ÚS 42/24",
    ]);
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["nalus-record:2001", "nalus-record:2002"]);
    expect(page.decisions.map(({ ecli }) => ecli)).toEqual([
      "ECLI:CZ:US:2024:1.US.42.24.1",
      "ECLI:CZ:US:2024:1.US.42.24.2",
    ]);
    expect(
      page.decisions.map(({ legacySourceUrls }) => legacySourceUrls),
    ).toEqual([
      ["https://nalus.usoud.cz/Search/GetText.aspx?sz=I-42-24_1"],
      undefined,
    ]);
  });

  test("stores the court the decision's own identifier names", async () => {
    const rows = [
      {
        id: "2101",
        sz: "I-43-24_1",
        caseNumber: "I.ÚS 43/24",
        date: "1. 2. 2024",
        ecli: "ECLI:CZ:US:2024:1.US.43.24.1",
      },
      // The same court, stated by nothing: a row NALUS lists without an
      // identifier still has to be attributed, and falls back to the
      // publisher's own court rather than to a bare code or to nothing.
      {
        id: "2102",
        sz: "I-44-24_1",
        caseNumber: "I.ÚS 44/24",
        date: "1. 2. 2024",
      },
    ];
    installSearchMock({ rows });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(page.decisions.map(({ court }) => court)).toEqual([
      "Ústavní soud",
      "Ústavní soud",
    ]);
    expect(page.decisions.map(({ metadata }) => metadata["court"])).toEqual([
      "Ústavní soud",
      "Ústavní soud",
    ]);
  });

  test("does not synthesize colliding ECLI aliases from unsafe counters", async () => {
    installSearchMock({
      rows: [
        {
          id: "2003",
          sz: "1-43-24_9007199254740992",
          caseNumber: "I.ÚS 43/24",
          date: "4. 1. 2024",
        },
        {
          id: "2004",
          sz: "1-43-24_9007199254740993",
          caseNumber: "I.ÚS 43/24",
          date: "4. 1. 2024",
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["nalus-record:2003", "nalus-record:2004"]);
    expect(page.decisions.every(({ ecli }) => ecli === undefined)).toBe(true);
    expect(
      page.decisions.every(
        ({ sourceDocumentIdAliases }) =>
          sourceDocumentIdAliases?.every(
            (identity) => !identity.startsWith("nalus-ecli:"),
          ) ?? true,
      ),
    ).toBe(true);
  });

  test("does not invent ECLI aliases when sibling counters are absent", async () => {
    installSearchMock({
      rows: [
        {
          id: "2005",
          sz: "document-without-counter-a",
          caseNumber: "I.ÚS 44/24",
          listedCounter: null,
          date: "4. 1. 2024",
        },
        {
          id: "2006",
          sz: "document-without-counter-b",
          caseNumber: "I.ÚS 44/24",
          listedCounter: null,
          date: "4. 1. 2024",
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["nalus-record:2005", "nalus-record:2006"]);
    expect(page.decisions.every(({ ecli }) => ecli === undefined)).toBe(true);
    expect(
      page.decisions.every(
        ({ sourceDocumentIdAliases }) =>
          sourceDocumentIdAliases?.every(
            (identity) => !identity.startsWith("nalus-ecli:"),
          ) ?? true,
      ),
    ).toBe(true);
  });

  test("uses the result banner for pagination and slice completion", async () => {
    const firstRows = Array.from({ length: RESULTS_PAGE_SIZE }, (_, index) => ({
      id: String(3000 + index),
      sz: `1-${index + 1}-24_1`,
      caseNumber: `I.ÚS ${index + 1}/24`,
      date: "1. 1. 2024",
    }));
    const tailRows = [
      {
        id: "3040",
        sz: `1-${RESULTS_PAGE_SIZE + 1}-24_1`,
        caseNumber: `I.ÚS ${RESULTS_PAGE_SIZE + 1}/24`,
        date: "2. 1. 2024",
      },
      {
        id: "3041",
        sz: `1-${RESULTS_PAGE_SIZE + 2}-24_1`,
        caseNumber: `I.ÚS ${RESULTS_PAGE_SIZE + 2}/24`,
        date: "2. 1. 2024",
      },
    ];
    const reported = RESULTS_PAGE_SIZE + tailRows.length;
    installSearchMock({ rows: firstRows, reported });
    const first = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    expect(first.nextCursor).toMatch(
      /^search:historical:\d{4}-\d{2}-\d{2}:2024:collect:1:[a-f0-9]+:-$/u,
    );

    installSearchMock({
      rows: tailRows,
      rangeFrom: RESULTS_PAGE_SIZE + 1,
      reported,
    });
    const last = unwrap(await czUsAdapter.fetchPage(first.nextCursor, {}));
    expect(last.nextCursor).toMatch(
      /^search:historical:\d{4}-\d{2}-\d{2}:2024:verify:0:0:[a-f0-9]+$/u,
    );

    installSearchMock({ rows: firstRows, reported });
    const verifyFirst = unwrap(
      await czUsAdapter.fetchPage(last.nextCursor, {}),
    );
    installSearchMock({
      rows: tailRows,
      rangeFrom: RESULTS_PAGE_SIZE + 1,
      reported,
    });
    const verified = unwrap(
      await czUsAdapter.fetchPage(verifyFirst.nextCursor, {}),
    );
    expect(verified.nextCursor).toBe(historicalCursor(2025));
  });

  test("restarts a traversal when a saved result page disappears", async () => {
    installSearchMock({
      rows: [
        {
          id: "3099",
          sz: "1-1-24_1",
          caseNumber: "I.ÚS 1/24",
          date: "2. 1. 2024",
        },
      ],
      rangeFrom: 1,
      reported: 1,
    });
    const availableTo = latestClosedAvailabilityDay();

    const pages = await Promise.all(
      [
        `search:historical:${availableTo}:2024:collect:1:prior:-`,
        `search:historical:${availableTo}:2024:verify:1:prior:expected`,
      ].map(async (cursor) => unwrap(await czUsAdapter.fetchPage(cursor, {}))),
    );

    for (const page of pages) {
      expect(page.decisions).toEqual([]);
      expect(page.nextCursor).toBe(
        `search:historical:${availableTo}:2024:collect:0:0:-`,
      );
    }
  });

  test("verifies a single-page slice before advancing", async () => {
    const firstRow = {
      id: "3100",
      sz: "1-1-24_1",
      caseNumber: "I.ÚS 1/24",
      date: "2. 1. 2024",
    };
    installSearchMock({ rows: [firstRow] });

    const collected = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    installSearchMock({
      rows: [
        firstRow,
        {
          id: "3101",
          sz: "2-2-24_1",
          caseNumber: "II.ÚS 2/24",
          date: "3. 1. 2024",
        },
      ],
    });
    const changed = unwrap(
      await czUsAdapter.fetchPage(collected.nextCursor, {}),
    );

    expect(changed.nextCursor).toBe(historicalCursor(2024));
  });

  test("legacy probe cursors restart the publisher enumeration", async () => {
    let submitted: URLSearchParams | undefined;
    installSearchMock({
      empty: true,
      onPost: (form) => {
        submitted = form;
      },
    });

    const page = unwrap(await czUsAdapter.fetchPage("3510:2024:recent", {}));

    expect(submitted?.get("ctl00$MainContent$decidedFrom")).toBe("1.1.1993");
    expect(page.nextCursor).toBe(historicalCursor(1994));
  });

  test("migrates a persisted rolling-window cursor without skipping its first unlisted day", async () => {
    let submitted: URLSearchParams | undefined;
    installSearchMock({
      empty: true,
      onPost: (form) => {
        submitted = form;
      },
    });
    // Exactly what the rolling window persisted after it finished 2026-08-04:
    // an inclusive lower bound on the first day it had not listed.
    const rollingWindowCursor =
      "search:recent:2026-08-05:2026-08-06:collect:0:0:-";

    const page = unwrap(await czUsAdapter.fetchPage(rollingWindowCursor, {}));

    expect(submitted?.get("ctl00$MainContent$availableFrom")).toBe("5.8.2026");
    expect(page.nextCursor).toBe(
      recentCursor(
        latestClosedAvailabilityDay(),
        latestClosedAvailabilityDay(),
      ),
    );
  });

  test("finishing the current decision year hands over to availability polling", async () => {
    installSearchMock({ empty: true });
    const currentYear = new Date().getUTCFullYear();

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(currentYear), {}),
    );

    expect(page.nextCursor).toMatch(
      /^search:recent-frontier:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}:collect:0:0:-$/u,
    );
    expect(page.nextCursor?.split(":").at(3)).toBe(
      latestClosedAvailabilityDay(),
    );
  });

  test("hands the historical snapshot day over as the recent frontier", async () => {
    installSearchMock({ empty: true });
    const currentYear = new Date().getUTCFullYear();
    const snapshotDay = addDays(latestClosedAvailabilityDay(), -90);

    const page = unwrap(
      await czUsAdapter.fetchPage(
        historicalCursor(currentYear, snapshotDay),
        {},
      ),
    );

    // The sweep filtered every year it walked on `snapshotDay`, so the days
    // after it are exactly what no pass has listed: the recent phase picks
    // them up in one window rather than losing or re-walking them.
    expect(page.nextCursor).toBe(
      recentCursor(snapshotDay, latestClosedAvailabilityDay()),
    );
  });

  test("recent polling queries publication availability rather than decision date", async () => {
    let submitted: URLSearchParams | undefined;
    installSearchMock({
      empty: true,
      onPost: (form) => {
        submitted = form;
      },
    });

    unwrap(
      await czUsAdapter.fetchPage(recentCursor("2026-06-23", "2026-08-07"), {}),
    );

    expect(
      submitted?.get("ctl00$MainContent$dle_data_zpristupneni"),
    ).toBeNull();
    expect(submitted?.get("ctl00$MainContent$availableFrom")).toBe("24.6.2026");
    expect(submitted?.get("ctl00$MainContent$availableTo")).toBe("7.8.2026");
    expect(submitted?.get("ctl00$MainContent$decidedFrom")).toBeNull();
  });

  test("abstract failure does not drop a listed decision", async () => {
    installSearchMock({
      rows: [
        {
          id: "4001",
          sz: "1-1-24_1",
          caseNumber: "I.ÚS 1/24",
          date: "1. 1. 2024",
        },
      ],
      abstractStatus: 500,
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    expect(page.decisions).toHaveLength(1);
    expect(page.decisions[0]?.caseNumber).toBe("I.ÚS 1/24");
    expect(page.decisions[0]?.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(
      decodeSourceRawEnvelope(page.decisions[0]?.sourceRaw ?? ""),
    ).toMatchObject({
      listing: expect.stringContaining("ResultDetail.aspx?id=4001"),
      document: expect.stringContaining("lblRegistrySign"),
    });
    expect(
      decodeSourceRawEnvelope(page.decisions[0]?.sourceRaw ?? ""),
    ).not.toHaveProperty("abstract");
  });

  test("enriches listed decisions with abstracts and legal sentences", async () => {
    const abstract = "Neutral source value";
    const legalSentence = "Neutral legal phrase";
    expect(abstract).toHaveLength(20);
    expect(legalSentence).toHaveLength(20);
    installSearchMock({
      rows: [
        {
          id: "5001",
          sz: "2-10-24_1",
          caseNumber: "II.ÚS 10/24",
          date: "2. 2. 2024",
        },
      ],
      abstract,
      legalSentence,
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    const decision = page.decisions.at(0);
    expect(decision?.textFields).toEqual({
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      abstract: { type: TEXT_FIELD_TYPE.PRESENT, text: abstract },
      legalSentence: { type: TEXT_FIELD_TYPE.PRESENT, text: legalSentence },
    });
    expect(decision?.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(decodeSourceRawEnvelope(decision?.sourceRaw ?? "")).toMatchObject({
      listing: expect.stringContaining("ResultDetail.aspx?id=5001"),
      document: expect.stringContaining("lblRegistrySign"),
      abstract: expect.stringContaining(abstract),
    });
  });

  test("moves the source hash when publisher text changes", async () => {
    const row = {
      id: "fixture-text-hash",
      sz: "fixture-text-hash_1",
      caseNumber: "Fixture 1",
      date: "1. 1. 2024",
    };
    installSearchMock({
      rows: [row],
      abstract: "First published summary is long enough to be retained.",
    });
    const first = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions.at(0);

    installSearchMock({
      rows: [row],
      abstract: "Second published summary is long enough to be retained.",
    });
    const second = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions.at(0);

    expect(first?.rawHash).not.toBe(second?.rawHash);
  });

  test("stores no headnote where the court prints that it has none", async () => {
    // Both cells are always filled: with the text, or with a sentence saying
    // there is none. The second is longer than any length threshold, so before
    // the markers were declared it was stored, indexed and shown as the
    // decision's headnote.
    installSearchMock({
      rows: [
        {
          id: "5002",
          sz: "2-11-24_1",
          caseNumber: "II.ÚS 11/24",
          date: "2. 2. 2024",
        },
      ],
      abstract: "Abstrakt není k dispozici.",
      legalSentence: "Právní věta není k dispozici.",
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    expect(page.decisions.at(0)?.textFields).toEqual({
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      abstract: {
        type: TEXT_FIELD_TYPE.ABSENT,
        reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
      },
      legalSentence: {
        type: TEXT_FIELD_TYPE.ABSENT,
        reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
      },
    });
    // The page the sentences came from is still stored, so a later reading
    // can recover whatever the court served.
    expect(
      decodeSourceRawEnvelope(page.decisions[0]?.sourceRaw ?? ""),
    ).toMatchObject({
      abstract: expect.stringContaining("Právní věta není k dispozici."),
    });
  });

  test("preserves abstract block breaks and replays the legacy saved envelope", async () => {
    const abstractHtml = makeAbstractPage(
      "Analytická právní věta<br/><br/>Plošné shromažďování údajů je nepřípustné.<br/><br/>Návrh a řízení před Ústavním soudem<br/><br/>Plénum návrhu vyhovělo.",
      "První právní věta.<br/><br/>Druhá právní věta.",
    );
    const textHtml = makeTextPage("Pl.ÚS 24/10", "22. 3. 2011", {
      counter: 1,
      decisionForm: "Nález",
    });
    const reparse = czUsAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("Expected cz-us to support stored-raw replay");
    }

    const outcome = await reparse({
      raw: new TextEncoder().encode(
        JSON.stringify({
          abstractHtml,
          listingHtml: "<html>listing</html>",
          textHtml,
        }),
      ),
      contentType: "application/json",
      caseNumber: "Pl.ÚS 24/10",
      sourceDocumentId: "nalus-record:69635",
      language: "cs",
      court: "Ústavní soud",
      ecli: "ECLI:CZ:US:2011:Pl.US.24.10.1",
      decisionDate: "2011-03-22",
      decisionType: "nález",
      sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=Pl-24-10_1",
      documentUrl: null,
      metadata: {
        ecliCounter: 1,
        nalusRecordId: "69635",
        nalusSz: "Pl-24-10_1",
      },
    });

    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return;
    }
    expect(outcome.result.textFields.abstract).toEqual({
      text: "Analytická právní věta\n\nPlošné shromažďování údajů je nepřípustné.\n\nNávrh a řízení před Ústavním soudem\n\nPlénum návrhu vyhovělo.",
      type: TEXT_FIELD_TYPE.PRESENT,
    });
    expect(outcome.result.textFields.legalSentence).toEqual({
      text: "První právní věta.\n\nDruhá právní věta.",
      type: TEXT_FIELD_TYPE.PRESENT,
    });
    expect(outcome.result.sourceRaw).toContain("abstractHtml");
  });

  test("preserves decision-page metadata while taking identity from search", async () => {
    const row = {
      id: "6001",
      sz: "Pl-14-24_1",
      caseNumber: "Pl.ÚS 14/24",
      date: "28. 5. 2024",
    };
    installSearchMock({ rows: [row] });
    const originalFetchForMetadata = globalThis.fetch;
    globalThis.fetch = asFetchMock(
      mock((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(resolveUrl(input));
        if (url.pathname.endsWith("/Search/GetText.aspx")) {
          return Promise.resolve(
            new Response(
              makeTextPage(row.caseNumber, row.date, {
                decisionForm: "Usnesení",
                parallelQuotation: "NALUS 14/24",
                popularName: "Testovací věc",
                counter: 1,
              }),
            ),
          );
        }
        return originalFetchForMetadata(input, init);
      }),
    );

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    const decision = page.decisions[0];
    expect(decision?.sourceDocumentId).toBe("nalus-record:6001");
    expect(decision?.legacySourceUrls).toBeUndefined();
    expect(decision?.decisionType).toBe("usnesení");
    expect(decision?.metadata).toMatchObject({
      judge: "Nováková Jana",
      parallelQuotation: "NALUS 14/24",
      popularName: "Testovací věc",
      ecliCounter: 1,
      nalusRecordId: "6001",
    });
  });

  test("rejects corrupt search cursors instead of silently restarting", async () => {
    installSearchMock({ empty: true });
    const result = await czUsAdapter.fetchPage("search:future:2026:0", {});
    expect(Result.isError(result)).toBe(true);
  });

  test("does not advance on an unconfirmed HTTP 200 search response", async () => {
    installSearchMock({ empty: true });
    const originalFetchForSearch = globalThis.fetch;
    globalThis.fetch = asFetchMock(
      mock((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(resolveUrl(input));
        if (
          url.pathname.endsWith("/Search/Search.aspx") &&
          requestMethod(input, init) === "POST"
        ) {
          return Promise.resolve(new Response(makeSearchForm()));
        }
        return originalFetchForSearch(input, init);
      }),
    );

    const result = await czUsAdapter.fetchPage(historicalCursor(2024), {});
    expect(Result.isError(result)).toBe(true);
  });

  test("rebuilds text URLs from the trusted NALUS origin", async () => {
    let requestedDetail: URL | undefined;
    let detailRedirect: RequestInit["redirect"];
    installSearchMock({
      rows: [
        {
          id: "7101",
          sz: "1-78-24_1",
          caseNumber: "I.ÚS 78/24",
          date: "2. 1. 2024",
          textUrl: "http://169.254.169.254/latest/GetText.aspx?sz=1-78-24_1",
        },
      ],
      onDetail: (url, init) => {
        requestedDetail = url;
        detailRedirect = init?.redirect;
      },
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(requestedDetail?.origin).toBe("https://nalus.usoud.cz");
    expect(detailRedirect).toBe("manual");
    expect(page.decisions[0]?.sourceUrl).toBe(
      "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-78-24_1",
    );
  });

  test("persists a listed identity with no text action", async () => {
    installSearchMock({
      rows: [
        {
          id: "7201",
          sz: "withdrawn-action-is-not-listed",
          caseNumber: "Pl.ÚS 9/24",
          listedCaseNumber: "",
          date: "3. 1. 2024",
          textUrl: null,
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(page.decisions[0]).toMatchObject({
      caseNumber: "NALUS record 7201",
      isListingOnly: true,
      sourceDocumentId: "nalus-record:7201",
      sourceUrl: "https://nalus.usoud.cz/Search/ResultDetail.aspx?id=7201",
      metadata: {
        ecliCounter: 1,
        nalusRecordId: "7201",
        listingDocketMissing: true,
        listedOnly: true,
        listedOnlyReason: "missing-text-action",
      },
    });
    expect(page.decisions[0]?.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(
      decodeSourceRawEnvelope(page.decisions[0]?.sourceRaw ?? ""),
    ).toMatchObject({
      listing: expect.stringContaining("ResultDetail.aspx?id=7201"),
    });
    const verified = unwrap(await czUsAdapter.fetchPage(page.nextCursor, {}));
    expect(verified.nextCursor).toBe(historicalCursor(2025));
  });

  test("uses an exact text identity when ResultDetail id is malformed", async () => {
    installSearchMock({
      rows: [
        {
          sz: "2-91-24_1",
          caseNumber: "II.ÚS 91/24",
          date: "4. 1. 2024",
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(page.decisions[0]).toMatchObject({
      caseNumber: "II.ÚS 91/24",
      sourceDocumentId: "nalus-sz:2-91-24_1",
      sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=2-91-24_1",
    });
    expect(page.decisions[0]?.sourceDocumentIdAliases).toContain(
      "nalus-ecli:ECLI:CZ:US:2024:2.US.91.24.1",
    );
    expect(page.decisions[0]?.sourceDocumentIdRepairAliases?.at(0)).toMatch(
      /^nalus-quarantine:[a-f0-9]+$/u,
    );
  });

  test("discards an oversized identity alias without poisoning its row", async () => {
    const oversizedSz = "x".repeat(300);
    installSearchMock({
      rows: [
        {
          id: "7392",
          sz: oversizedSz,
          caseNumber: "II.ÚS 92/24",
          date: "4. 1. 2024",
        },
      ],
    });

    const decision = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];

    expect(decision).toMatchObject({
      sourceDocumentId: "nalus-record:7392",
      sourceUrl: "https://nalus.usoud.cz/Search/ResultDetail.aspx?id=7392",
      isListingOnly: true,
      metadata: { listedOnlyReason: "missing-text-action" },
    });
    expect(
      decision?.sourceDocumentIdAliases?.some((identity) =>
        identity.startsWith("nalus-sz:"),
      ) ?? false,
    ).toBe(false);
    expect(decision?.sourceUrl).not.toContain(oversizedSz);
  });

  test("discards an empty retrieval identity without merging malformed rows", async () => {
    installSearchMock({
      rows: [
        {
          id: "7393",
          sz: "",
          caseNumber: "II.ÚS 93/24",
          date: "4. 1. 2024",
          textUrl: "https://nalus.usoud.cz:443/Search/GetText.aspx?sz=&foo=x",
        },
      ],
    });

    const decision = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];

    expect(decision?.sourceDocumentId).toBe("nalus-record:7393");
    expect(decision?.sourceDocumentIdAliases).toBeUndefined();
    expect(decision).toMatchObject({
      isListingOnly: true,
      metadata: { listedOnlyReason: "missing-text-action" },
    });
  });

  test("publishes overlapping identities before a record link disappears", async () => {
    installSearchMock({
      rows: [
        {
          id: "7391",
          sz: "2-91-24_1",
          caseNumber: "II.ÚS 91/24",
          date: "4. 1. 2024",
        },
      ],
    });
    const canonical = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];
    expect(canonical).toMatchObject({
      sourceDocumentId: "nalus-record:7391",
    });
    expect(canonical?.sourceDocumentIdAliases).toEqual(
      expect.arrayContaining([
        "nalus-sz:2-91-24_1",
        "nalus-ecli:ECLI:CZ:US:2024:2.US.91.24.1",
      ]),
    );

    installSearchMock({
      rows: [
        {
          sz: "2-91-24_1",
          caseNumber: "II.ÚS 91/24",
          date: "4. 1. 2024",
        },
      ],
    });
    const fallback = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];
    expect(fallback).toMatchObject({
      sourceDocumentId: "nalus-sz:2-91-24_1",
    });
    expect(fallback?.sourceDocumentIdAliases).toEqual(
      expect.arrayContaining(["nalus-ecli:ECLI:CZ:US:2024:2.US.91.24.1"]),
    );
  });

  test("quarantines a counted row that exposes neither NALUS identity", async () => {
    installSearchMock({
      rows: [
        {
          sz: "",
          caseNumber: "Pl.ÚS 10/24",
          date: "4. 1. 2024",
          textUrl: null,
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    expect(page.decisions[0]).toMatchObject({
      caseNumber: "Pl.ÚS 10/24",
      isListingOnly: true,
      metadata: {
        identityQuarantined: true,
        listedOnly: true,
        listedOnlyReason: "missing-record-identity",
      },
    });
    expect(page.decisions[0]?.sourceDocumentId).toMatch(
      /^nalus-quarantine:[a-f0-9]+$/u,
    );
    expect(page.decisions[0]?.sourceUrl).toMatch(
      /^https:\/\/nalus\.usoud\.cz\/Search\/Results\.aspx#listing-[a-f0-9]+$/u,
    );
    expect(page.decisions[0]?.sourceRaw).toContain("Pl.ÚS 10/24");

    installSearchMock({
      rows: [
        {
          sz: "",
          caseNumber: "Pl.ÚS 10/24",
          date: "4. 1. 2024",
          textUrl: null,
        },
      ],
      renderPositionOffset: 1,
    });
    const verified = unwrap(await czUsAdapter.fetchPage(page.nextCursor, {}));
    expect(verified.nextCursor).toBe(historicalCursor(2025));

    installSearchMock({
      rows: [
        {
          id: "7401",
          sz: "",
          caseNumber: "Pl.ÚS 10/24",
          date: "4. 1. 2024",
          textUrl: null,
        },
      ],
    });
    const recovered = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];
    expect(recovered).toMatchObject({
      sourceDocumentId: "nalus-record:7401",
      isListingOnly: true,
    });
    expect(recovered?.sourceDocumentIdRepairAliases).toContain(
      page.decisions[0]?.sourceDocumentId,
    );
  });

  test("keeps identity-less dockets distinct in quarantine", async () => {
    installSearchMock({
      rows: [
        {
          sz: "",
          caseNumber: "Pl.ÚS 13/24",
          date: "4. 1. 2024",
          textUrl: null,
        },
        {
          sz: "",
          caseNumber: "Pl.ÚS 14/24",
          date: "4. 1. 2024",
          textUrl: null,
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    const quarantineIds = page.decisions.map(
      ({ sourceDocumentId }) => sourceDocumentId,
    );

    expect(quarantineIds).toHaveLength(2);
    expect(new Set(quarantineIds).size).toBe(2);
    expect(
      quarantineIds.every(
        (identity) => identity?.startsWith("nalus-quarantine:") === true,
      ),
    ).toBe(true);
  });

  test("keeps identity-less siblings distinct by listing counter", async () => {
    installSearchMock({
      rows: [
        {
          sz: "",
          caseNumber: "Pl.ÚS 15/24",
          listedCounter: "1",
          date: "4. 1. 2024",
          textUrl: null,
        },
        {
          sz: "",
          caseNumber: "Pl.ÚS 15/24",
          listedCounter: "2",
          date: "4. 1. 2024",
          textUrl: null,
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    const quarantineIds = page.decisions.map(
      ({ sourceDocumentId }) => sourceDocumentId,
    );

    expect(page.decisions.map(({ caseNumber }) => caseNumber)).toEqual([
      "Pl.ÚS 15/24",
      "Pl.ÚS 15/24",
    ]);
    expect(new Set(quarantineIds).size).toBe(2);
  });

  test("keeps the repair identity when ECLI and the detail docket recover", async () => {
    installSearchMock({
      rows: [
        {
          sz: "",
          caseNumber: "Pl.ÚS 11/24",
          listedCaseNumber: "",
          date: "4. 1. 2024",
          textUrl: null,
        },
      ],
    });
    const quarantined = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];

    installSearchMock({
      rows: [
        {
          id: "7402",
          sz: "",
          caseNumber: "Pl.ÚS 11/24",
          date: "4. 1. 2024",
          ecli: "ECLI:CZ:US:2024:Pl.US.11.24.1",
          textUrl: null,
        },
      ],
    });
    const recovered = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];

    expect(quarantined?.sourceDocumentId).toMatch(
      /^nalus-quarantine:[a-f0-9]+$/u,
    );
    expect(recovered).toMatchObject({
      caseNumber: "Pl.ÚS 11/24",
      ecli: "ECLI:CZ:US:2024:Pl.US.11.24.1",
      sourceDocumentId: "nalus-record:7402",
    });
    expect(recovered?.sourceDocumentIdRepairAliases).toContain(
      quarantined?.sourceDocumentId,
    );
  });

  test("keeps the repair identity when a visible text action recovers", async () => {
    installSearchMock({
      rows: [
        {
          sz: "",
          caseNumber: "Pl.ÚS 12/24",
          date: "4. 1. 2024",
          textUrl: null,
        },
      ],
    });
    const quarantined = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];

    installSearchMock({
      rows: [
        {
          sz: "Pl-12-24_1",
          caseNumber: "Pl.ÚS 12/24",
          date: "4. 1. 2024",
          textActionLabel: "Text rozhodnutí",
        },
      ],
    });
    const recovered = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    ).decisions[0];

    expect(recovered).toMatchObject({
      caseNumber: "Pl.ÚS 12/24",
      sourceDocumentId: "nalus-sz:Pl-12-24_1",
    });
    expect(recovered?.sourceDocumentIdRepairAliases).toContain(
      quarantined?.sourceDocumentId,
    );
  });

  test("recovers a missing listed docket from the decision detail", async () => {
    installSearchMock({
      rows: [
        {
          id: "7301",
          sz: "3-81-24_1",
          caseNumber: "III.ÚS 81/24",
          listedCaseNumber: "",
          date: "4. 1. 2024",
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(page.decisions[0]).toMatchObject({
      caseNumber: "III.ÚS 81/24",
      sourceDocumentId: "nalus-record:7301",
      metadata: { listingDocketMissing: true },
    });
  });

  test("persists a listed identity when its detail is permanently unparseable", async () => {
    installSearchMock({
      rows: [
        {
          id: "7001",
          sz: "1-77-24_1",
          caseNumber: "I.ÚS 77/24",
          date: "1. 1. 2024",
        },
      ],
      unparseableDetail: true,
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    expect(page.decisions[0]).toMatchObject({
      caseNumber: "I.ÚS 77/24",
      isListingOnly: true,
      sourceDocumentId: "nalus-record:7001",
      metadata: {
        listedOnly: true,
        listedOnlyReason: "unparseable-detail",
      },
    });
    expect(page.decisions[0]?.legacySourceUrls).toBeUndefined();
    expect(page.decisions[0]?.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(
      decodeSourceRawEnvelope(page.decisions[0]?.sourceRaw ?? ""),
    ).toMatchObject({
      listing: expect.stringContaining("ResultDetail.aspx?id=7001"),
      document: expect.stringContaining("detail unavailable"),
    });
    const verified = unwrap(await czUsAdapter.fetchPage(page.nextCursor, {}));
    expect(verified.nextCursor).toBe(historicalCursor(2025));
  });

  test("carries the frontier to the latest closed day and then stands still", async () => {
    const latest = latestClosedAvailabilityDay();
    installSearchMock({ empty: true });

    const walked = unwrap(
      await czUsAdapter.fetchPage(recentCursor("2025-01-01", "2025-02-14"), {}),
    );
    expect(walked.nextCursor).toBe(recentCursor("2025-02-14", latest));

    // The frontier has reached the court's last closed day, so the next cycle
    // has nothing to list: it must cost the publisher no request at all.
    const fetchCalls = fetchCallCount();
    const idle = unwrap(
      await czUsAdapter.fetchPage(recentCursor(latest, latest), {}),
    );

    expect(idle.decisions).toEqual([]);
    expect(idle.nextCursor).toBe(recentCursor(latest, latest));
    expect(fetchCallCount()).toBe(fetchCalls);
  });

  test("a new closed day costs one listing and its decisions, once", async () => {
    const latest = latestClosedAvailabilityDay();
    const rows = [
      {
        id: "8001",
        sz: "1-7-26_1",
        caseNumber: "I.ÚS 7/26",
        date: "6. 8. 2026",
      },
      {
        id: "8002",
        sz: "2-7-26_1",
        caseNumber: "II.ÚS 7/26",
        date: "6. 8. 2026",
      },
    ];
    let submitted: URLSearchParams | undefined;
    installSearchMock({
      rows,
      onPost: (form) => {
        submitted = form;
      },
    });

    // One closed day behind the frontier: the day after `latest - 1`.
    const collect = unwrap(
      await czUsAdapter.fetchPage(
        recentCursor(addDays(latest, -1), latest),
        {},
      ),
    );
    expect(submitted?.get("ctl00$MainContent$availableFrom")).toBe(
      czechDay(latest),
    );
    expect(collect.decisions).toHaveLength(rows.length);
    // 3 listing requests, then a text, a record card and an abstract per row.
    expect(fetchCallCount()).toBe(3 + rows.length * 3);

    const verify = unwrap(await czUsAdapter.fetchPage(collect.nextCursor, {}));
    expect(verify.decisions).toEqual([]);
    // One re-listing confirms the window; nothing is fetched twice.
    expect(fetchCallCount()).toBe(3 + rows.length * 3 + 3);
    expect(verify.nextCursor).toBe(recentCursor(latest, latest));

    // And the frontier now stands still rather than re-listing the day.
    const settled = fetchCallCount();
    const idle = unwrap(await czUsAdapter.fetchPage(verify.nextCursor, {}));
    expect(idle.nextCursor).toBe(verify.nextCursor);
    expect(fetchCallCount()).toBe(settled);
  });

  test("the publisher's rate-limit redirect halts the page without moving the cursor", async () => {
    const cursor = recentCursor("2026-06-23", "2026-08-07");
    installRawMock(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://nalus.usoud.cz/limit-exceeded.html" },
        }),
    );

    const result = await czUsAdapter.fetchPage(cursor, {});

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      throw new TypeError("the rate-limit redirect must not produce a page");
    }
    expect(result.error).toMatchObject({
      adapterKey: "cz-us",
      cursor,
      httpStatus: 302,
    });
    expect(result.error.message).toContain("rate limit");
    expect(result.error.cause).toBeInstanceOf(NalusRateLimitedError);
    // One request learns the limit is still in force; the page fetches nothing
    // else and the cursor it was given is the cursor it leaves behind.
    expect(fetchCallCount()).toBe(1);
  });

  test("a plain 429 is the same halt as the limit page", async () => {
    installRawMock(() => new Response("slow down", { status: 429 }));

    const result = await czUsAdapter.fetchPage(historicalCursor(2024), {});

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      throw new TypeError("a 429 must not produce a page");
    }
    expect(result.error).toMatchObject({ httpStatus: 429 });
    expect(result.error.message).toContain("rate limit");
  });

  test("an ordinary 302 to the results page is not a rate limit", async () => {
    installSearchMock({ rows: [], reported: 0 });

    // The search form answers a valid submit with a 302; only the limit page
    // as the redirect target says the budget is spent.
    const result = await czUsAdapter.fetchPage(historicalCursor(2024), {});

    expect(Result.isOk(result)).toBe(true);
  });

  test("reads a submit redirected away from the results page as a failure", async () => {
    installSearchMock({
      rows: [
        {
          id: "3001",
          sz: "I-1-24_1",
          caseNumber: "I.\u00daS 1/24",
          date: "1. 2. 2024",
        },
      ],
      submitLocation: "/Error.aspx",
    });

    const result = await czUsAdapter.fetchPage(historicalCursor(2024), {});

    if (!Result.isError(result)) {
      throw new TypeError("a refused search must not produce a page");
    }
    expect(result.error.message).toBe(
      "NALUS search returned HTTP 302 to https://nalus.usoud.cz/Error.aspx",
    );
    // The form read and the submit, and nothing after them: unchecked, the
    // crawl spent a further request on the results page the court serves
    // empty once the search behind it failed, and blamed that empty page.
    expect(fetchCallCount()).toBe(2);
  });

  test("accepts the submit redirect a valid search is answered with", async () => {
    installSearchMock({
      rows: [
        {
          id: "3002",
          sz: "I-2-24_1",
          caseNumber: "I.\u00daS 2/24",
          date: "1. 2. 2024",
        },
      ],
    });

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );

    expect(page.decisions).toHaveLength(1);
  });

  test("names where a redirected request was sent, without its query", async () => {
    installRedirectMock(
      "https://nalus.usoud.cz/Error/Unavailable.aspx?ret=%2FSearch%2FSearch.aspx",
    );

    const result = await czUsAdapter.fetchPage(historicalCursor(2024), {});

    if (!Result.isError(result)) {
      throw new TypeError("an unfollowed redirect must not produce a page");
    }
    expect(result.error.message).toBe(
      "NALUS search form returned HTTP 302 to https://nalus.usoud.cz/Error/Unavailable.aspx",
    );
  });

  test.each([
    ["mailto:ops@example.com", "(mailto:)"],
    ["data:text/html,<b>payload</b>", "(data:)"],
  ])(
    "names the scheme, never the body, of an opaque redirect (%s)",
    async (location, expected) => {
      installRedirectMock(location);

      const result = await czUsAdapter.fetchPage(historicalCursor(2024), {});

      if (!Result.isError(result)) {
        throw new TypeError("an unfollowed redirect must not produce a page");
      }
      expect(result.error.message).toBe(
        `NALUS search form returned HTTP 302 to a non-HTTP Location ${expected}`,
      );
    },
  );

  test("truncates an overlong redirect path", async () => {
    installRedirectMock(`https://nalus.usoud.cz/${"a".repeat(500)}`);

    const result = await czUsAdapter.fetchPage(historicalCursor(2024), {});

    if (!Result.isError(result)) {
      throw new TypeError("an unfollowed redirect must not produce a page");
    }
    expect(result.error.message).toBe(
      `NALUS search form returned HTTP 302 to https://nalus.usoud.cz/${"a".repeat(199)}…`,
    );
  });
});

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const recordCardFixture = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

describe("the record card the court prints beside a decision", () => {
  test("reads every label it states, and both judge roles in printed order", async () => {
    const fields = parseNalusDetail(
      await recordCardFixture("cz-us-record-card-dissents.html.gz"),
    );

    expect(fields?.caseNumber).toEqual(["Pl.ÚS 1/12"]);
    expect(fields?.decisionForm).toEqual(["Nález"]);
    expect(fields?.rapporteur).toEqual(["Rychetský Pavel"]);
    // One cell, nine names: the court separates repeats inside it, and a
    // reader that took the cell's text would store them as one name.
    expect(fields?.dissentingJudges).toEqual([
      "Balík Stanislav",
      "Formánková Vlasta",
      "Holländer Pavel",
      "Janů Ivana",
      "Kůrka Vladimír",
      "Lastovecká Dagmar",
      "Musil Jan",
      "Nykodým Jiří",
      "Výborný Miloslav",
    ]);
    expect(fields?.petitioner).toEqual([
      "SKUPINA POSLANCŮ",
      "SKUPINA POSLANCŮ",
      "SKUPINA SENÁTORŮ",
    ]);
    // A label the court prints with nothing in it is a field with no values,
    // never a value that happens to be blank.
    expect(fields?.note).toEqual([]);
  });

  test("states no dissent where the court printed none", async () => {
    const fields = parseNalusDetail(
      await recordCardFixture("cz-us-record-card.html.gz"),
    );

    expect(fields?.rapporteur).toEqual(["Brožová Iva"]);
    expect(fields?.dissentingJudges).toEqual([]);
    expect(fields?.decisionForm).toEqual(["Usnesení"]);
  });

  test("reads no card from a page that carries none", () => {
    expect(parseNalusDetail("<html><body>Search</body></html>")).toBeNull();
  });
});

describe("czUsAdapter judges", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
  });

  afterAll(() => {
    setSystemTime();
  });

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const decisionWithCard = async (
    options: Parameters<typeof installSearchMock>[0],
  ) => {
    installSearchMock({
      rows: [
        {
          id: "8001",
          sz: "Pl-9-26_1",
          caseNumber: "Pl.ÚS 9/26",
          date: "3. 2. 2026",
        },
      ],
      ...options,
    });
    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2026), {}),
    );
    return page.decisions.at(0);
  };

  test("carries the rapporteur first and the dissenters as printed", async () => {
    const decision = await decisionWithCard({
      rapporteur: "JUDr. Nováková Jana, Ph.D.",
      dissenters: ["Dvořák Petr", "Mgr. Svobodová Eva"],
    });

    expect(decision?.judges).toEqual([
      { role: "rapporteur", nameAsPrinted: "Nováková Jana" },
      { role: "dissenting", nameAsPrinted: "Dvořák Petr" },
      { role: "dissenting", nameAsPrinted: "Svobodová Eva" },
    ]);
    // The facts row still reads one name, from the same source field.
    expect(decision?.metadata["judge"]).toBe("Nováková Jana");
  });

  test("carries only the rapporteur where no separate opinion was filed", async () => {
    const decision = await decisionWithCard({ dissenters: [] });

    expect(decision?.judges).toEqual([
      { role: "rapporteur", nameAsPrinted: "Nováková Jana" },
    ]);
  });

  test("stores the card beside the document so a re-read costs no request", async () => {
    const decision = await decisionWithCard({ dissenters: ["Dvořák Petr"] });

    expect(decision?.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(decodeSourceRawEnvelope(decision?.sourceRaw ?? "")).toMatchObject({
      detail: expect.stringContaining("Odlišné stanovisko"),
      document: expect.stringContaining("lblRegistrySign"),
    });
  });

  test("says so on the row when the court could not serve the card", async () => {
    const decision = await decisionWithCard({ recordCardStatus: 500 });

    expect(decision?.judges).toBeUndefined();
    expect(decision?.metadata["recordCard"]).toBe("unavailable");
    expect(
      decodeSourceRawEnvelope(decision?.sourceRaw ?? ""),
    ).not.toHaveProperty("detail");
  });

  // The two gaps are not the same question: the backfill asks again about the
  // one that says nothing and never about the one the court answered.
  test("says the court holds no card where it answered 404", async () => {
    const decision = await decisionWithCard({ recordCardStatus: 404 });

    expect(decision?.judges).toBeUndefined();
    expect(decision?.metadata["recordCard"]).toBe("absent");
  });

  test("states an empty bench where the card names no judge", async () => {
    const decision = await decisionWithCard({
      rapporteur: "",
      dissenters: [],
    });

    // Empty, not absent: the pipeline replaces the stored judges only for an
    // observation that carries the field, and this card states there are none.
    expect(decision?.judges).toEqual([]);
  });
});

describe("czUsAdapter.reparseStoredRaw", () => {
  const storedInput = (raw: string, contentType: string | null) => ({
    raw: new TextEncoder().encode(raw),
    contentType,
    caseNumber: "Pl.ÚS 9/26",
    sourceDocumentId: "nalus-record:8001",
    language: "cs",
    court: "Ústavní soud",
    ecli: "ECLI:CZ:US:2026:Pl.US.9.26.1",
    decisionDate: "2026-02-03",
    decisionType: "nález",
    sourceUrl: "https://nalus.usoud.cz/Search/GetText.aspx?sz=Pl-9-26_1",
    documentUrl: null,
    metadata: { nalusRecordId: "8001", nalusSz: "Pl-9-26_1" },
  });

  const textPage = makeTextPage("Pl.ÚS 9/26", "3. 2. 2026", { counter: 1 });

  test("reads the judges back out of an envelope without contacting the court", async () => {
    const stored = storedInput(
      JSON.stringify({
        version: 1,
        parts: {
          document: textPage,
          detail: makeRecordCardPage("Pl.ÚS 9/26", "3. 2. 2026", {
            dissenters: ["Dvořák Petr", "Svobodová Eva"],
          }),
        },
      }),
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );

    const outcome = await czUsAdapter.reparseStoredRaw?.(stored);
    expect(outcome?.type).toBe("parsed");
    expect(
      outcome?.type === "parsed" ? outcome.result.judges : undefined,
    ).toEqual([
      { role: "rapporteur", nameAsPrinted: "Nováková Jana" },
      { role: "dissenting", nameAsPrinted: "Dvořák Petr" },
      { role: "dissenting", nameAsPrinted: "Svobodová Eva" },
    ]);
  });

  test("still reads a payload stored before the envelope, and states no judges for it", async () => {
    const outcome = await czUsAdapter.reparseStoredRaw?.(
      storedInput(textPage, "text/html"),
    );

    expect(outcome?.type).toBe("parsed");
    if (outcome?.type !== "parsed") {
      return;
    }
    // A plain payload holds the document alone. Nothing invents judges from
    // its prose, and the row keeps whatever it already stored.
    expect(outcome.result.judges).toBeUndefined();
    expect(outcome.result.caseNumber).toBe("Pl.ÚS 9/26");
  });
});
