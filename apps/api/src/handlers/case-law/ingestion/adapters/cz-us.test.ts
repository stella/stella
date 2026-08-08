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

import { czUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

type ResultRow = {
  id: string;
  sz: string;
  caseNumber: string;
  listedCaseNumber?: string | undefined;
  date: string;
  ecli?: string | undefined;
  textUrl?: string | null | undefined;
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

const makeTextPage = (
  caseNumber: string,
  date: string,
  fields: {
    decisionForm?: string;
    parallelQuotation?: string;
    popularName?: string;
    counter?: number;
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

const makeAbstractPage = (abstract = "", legalSentence = ""): string => `
<html><body>
  <table class="abstractContent"><tr><td>${abstract}</td></tr></table>
  <table class="legalSentenceContent"><tr><td>${legalSentence}</td></tr></table>
</body></html>`;

const makeResultsPage = (
  rows: readonly ResultRow[],
  rangeFrom: number,
  reported: number,
): string => {
  const rangeTo = rangeFrom + rows.length - 1;
  const body = rows
    .map((row, index) => {
      const counter = /_(?<counter>\d+)$/u.exec(row.sz)?.groups?.["counter"];
      const textUrl =
        row.textUrl === undefined
          ? `https://nalus.usoud.cz:443/Search/GetText.aspx?sz=${row.sz}`
          : row.textUrl;
      return `
<tr class='resultData${index % 2}'>
  <td></td>
  <td><a href='ResultDetail.aspx?id=${row.id}&pos=${rangeFrom + index}&cnt=${reported}&typ=result'>${row.listedCaseNumber ?? row.caseNumber} #${counter ?? "1"}</a><br />${row.ecli ?? ""}<br />Jan Novák</td>
</tr>
<tr class='resultData${index % 2}' valign="top">
  <td>${textUrl ? `<img onclick='javascript:ShowLink("${textUrl}", "Odkaz", "")' />` : ""}</td>
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
  unparseableDetail?: boolean;
  onPost?: (form: URLSearchParams, headers: Headers) => void;
  onDetail?: (url: URL, init?: RequestInit) => void;
};

const installSearchMock = ({
  rows = [],
  rangeFrom = 1,
  reported = rows.length,
  empty = false,
  abstract = "",
  legalSentence = "",
  abstractStatus = 200,
  detailStatus = 200,
  unparseableDetail = false,
  onPost,
  onDetail,
}: MockSearchOptions): void => {
  const bySz = new Map(rows.map((row) => [row.sz, row]));
  globalThis.fetch = asFetchMock(
    mock((input: string | URL | Request, init?: RequestInit) => {
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
        onPost?.(
          new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
          new Headers(init?.headers),
        );
        return Promise.resolve(
          empty
            ? new Response(makeNoResultsPage())
            : new Response(null, {
                status: 302,
                headers: { Location: "/Search/Results.aspx" },
              }),
        );
      }
      if (url.pathname.endsWith("/Search/Results.aspx")) {
        return Promise.resolve(
          new Response(makeResultsPage(rows, rangeFrom, reported)),
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
                      counterText === undefined
                        ? {}
                        : { counter: Number(counterText) },
                    ),
                { status: detailStatus },
              )
            : new Response("missing", { status: 404 }),
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

const recentCursor = (availableFrom: string, availableTo: string): string =>
  `search:recent:${availableFrom}:${availableTo}:collect:0:0:-`;

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
    expect(submitted?.get("ctl00$MainContent$resultsPageSize")).toBe("40");
    expect(page.decisions.map(({ caseNumber }) => caseNumber)).toEqual(
      rows.map(({ caseNumber }) => caseNumber),
    );
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["nalus-record:1001", "nalus-record:1002", "nalus-record:1003"]);
    expect(page.nextCursor).toBe(historicalCursor(1994));
    expect(page.coverage).toEqual({
      slice: "decision-year:1993",
      reported: 3,
      collected: 3,
    });
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

  test("uses the result banner for pagination and slice coverage", async () => {
    const firstRows = Array.from({ length: 40 }, (_, index) => ({
      id: String(3000 + index),
      sz: `1-${index + 1}-24_1`,
      caseNumber: `I.ÚS ${index + 1}/24`,
      date: "1. 1. 2024",
    }));
    installSearchMock({ rows: firstRows, reported: 42 });
    const first = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(2024), {}),
    );
    expect(first.nextCursor).toMatch(
      /^search:historical:\d{4}-\d{2}-\d{2}:2024:collect:1:[a-f0-9]+:-$/u,
    );
    expect(first.coverage).toBeUndefined();

    installSearchMock({
      rows: [
        {
          id: "3040",
          sz: "1-41-24_1",
          caseNumber: "I.ÚS 41/24",
          date: "2. 1. 2024",
        },
        {
          id: "3041",
          sz: "1-42-24_1",
          caseNumber: "I.ÚS 42/24",
          date: "2. 1. 2024",
        },
      ],
      rangeFrom: 41,
      reported: 42,
    });
    const last = unwrap(await czUsAdapter.fetchPage(first.nextCursor, {}));
    expect(last.coverage).toBeUndefined();
    expect(last.nextCursor).toMatch(
      /^search:historical:\d{4}-\d{2}-\d{2}:2024:verify:0:0:[a-f0-9]+$/u,
    );

    installSearchMock({ rows: firstRows, reported: 42 });
    const verifyFirst = unwrap(
      await czUsAdapter.fetchPage(last.nextCursor, {}),
    );
    installSearchMock({
      rows: [
        {
          id: "3040",
          sz: "1-41-24_1",
          caseNumber: "I.ÚS 41/24",
          date: "2. 1. 2024",
        },
        {
          id: "3041",
          sz: "1-42-24_1",
          caseNumber: "I.ÚS 42/24",
          date: "2. 1. 2024",
        },
      ],
      rangeFrom: 41,
      reported: 42,
    });
    const verified = unwrap(
      await czUsAdapter.fetchPage(verifyFirst.nextCursor, {}),
    );
    expect(verified.coverage).toEqual({
      slice: "decision-year:2024",
      reported: 42,
      collected: 42,
    });
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
    expect(page.coverage).toEqual({
      slice: "decision-year:1993",
      reported: 0,
      collected: 0,
    });
  });

  test("finishing the current decision year hands over to availability polling", async () => {
    installSearchMock({ empty: true });
    const currentYear = new Date().getUTCFullYear();

    const page = unwrap(
      await czUsAdapter.fetchPage(historicalCursor(currentYear), {}),
    );

    expect(page.nextCursor).toMatch(
      /^search:recent:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}:collect:0:0:-$/u,
    );
    expect(page.nextCursor?.split(":").at(3)).toBe(
      latestClosedAvailabilityDay(),
    );
  });

  test("catches up every publication day after the historical snapshot", async () => {
    installSearchMock({ empty: true });
    const currentYear = new Date().getUTCFullYear();
    const snapshotDay = addDays(latestClosedAvailabilityDay(), -90);

    const page = unwrap(
      await czUsAdapter.fetchPage(
        historicalCursor(currentYear, snapshotDay),
        {},
      ),
    );

    expect(page.nextCursor).toBe(
      recentCursor(addDays(snapshotDay, 1), addDays(snapshotDay, 45)),
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

    const page = unwrap(
      await czUsAdapter.fetchPage(recentCursor("2026-06-24", "2026-08-07"), {}),
    );

    expect(
      submitted?.get("ctl00$MainContent$dle_data_zpristupneni"),
    ).toBeNull();
    expect(submitted?.get("ctl00$MainContent$availableFrom")).toBe("24.6.2026");
    expect(submitted?.get("ctl00$MainContent$availableTo")).toBe("7.8.2026");
    expect(submitted?.get("ctl00$MainContent$decidedFrom")).toBeNull();
    expect(page.coverage).toEqual({
      slice: "availability:2026-06-24:2026-08-07",
      reported: 0,
      collected: 0,
    });
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
  });

  test("enriches listed decisions with abstracts and legal sentences", async () => {
    const abstract =
      "This abstract is long enough to pass the extraction threshold.";
    const legalSentence =
      "This legal sentence is also long enough to pass the extraction threshold.";
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
    expect(page.decisions[0]?.metadata["abstract"]).toBe(abstract);
    expect(page.decisions[0]?.metadata["legalSentence"]).toBe(legalSentence);
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
      judge: "amet. Jan Novák",
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
      sourceDocumentId: "nalus-record:7201",
      sourceUrl: "https://nalus.usoud.cz/Search/ResultDetail.aspx?id=7201",
      metadata: {
        nalusRecordId: "7201",
        listingDocketMissing: true,
        listedOnly: true,
        listedOnlyReason: "missing-text-action",
      },
    });
    expect(page.coverage?.collected).toBe(1);
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
      sourceDocumentId: "nalus-record:7001",
      metadata: {
        listedOnly: true,
        listedOnlyReason: "unparseable-detail",
      },
    });
    expect(page.decisions[0]?.legacySourceUrls).toBeUndefined();
    expect(page.coverage?.collected).toBe(1);
  });

  test("catches up recent availability in contiguous bounded windows", async () => {
    installSearchMock({ empty: true });
    const page = unwrap(
      await czUsAdapter.fetchPage(recentCursor("2025-01-01", "2025-02-14"), {}),
    );

    expect(page.nextCursor).toBe(
      "search:recent:2025-02-15:2025-03-31:collect:0:0:-",
    );
  });
});
