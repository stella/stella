/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import {
  buildSkUsDecision,
  skUsAdapter,
  skUsListingIdentity,
  SK_US_FIRST_SLICE,
} from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  AdapterFetchError,
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import { readGzipJson } from "@/api/lib/gzip-json";
import {
  decodeSourceRawEnvelope,
  listingIdentityKey,
  SOURCE_DOCUMENT_ID_MAX_LENGTH,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const reconciliation = requireReconciliation(skUsAdapter);

const SEARCH_PATH = "/o/v1/dms/search";
const CONTENT_PATH = "/o/v1/dms/content";
const CODELIST_PATH = "/o/v1/codelist/decision";
const COURT_FILE_PREFIX = "/o/v1/dms/file/";
const DOWNLOAD_PREFIX = "/docDownload/";

/**
 * The decision text the stubbed service renders, carrying one anonymized
 * run: a black-on-black span over non-breaking spaces, which is how this
 * court redacts.
 */
const DOCUMENT_XHTML =
  `<html><body><div><span style="font-size: 21px; ">N\u00c1LEZ<br/><br/></span>` +
  `<span style="font-size: 12px; ">\u00dastavn\u00fd s\u00fad rozhodol o s\u0165a\u017enosti s\u0165a\u017eovate\u013ea <br/></span>` +
  `<span style="color: #000000; background-color: #000000; font-size: 12px; ">${"&nbsp;".repeat(6)}</span>` +
  `<span style="font-size: 12px; "> takto <br/><br/>rozh od ol :  <br/><br/>` +
  `S\u0165a\u017enosti sa vyhovuje. <br/></span></div></body></html>`;

const CODELIST_BODY = JSON.stringify({
  codelist: {
    mkJudgeReporter: ["Ivan Fia\u010dan"],
    mkDifferentViewJudges: ["Peter Straka"],
  },
});

const COURT_FILE_BODY = JSON.stringify({
  documents: [
    {
      docType: "USSR_COURTFILE",
      documentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      mkEntryDate: "06/30/2020 00:00:00",
      mkReferences: ["2196/2020"],
    },
  ],
  numFound: 1,
});

/** The facet counts a docket-narrowed search answers with. */
const facetsBody = (judges: readonly string[]): string =>
  JSON.stringify({
    documents: [],
    numFound: judges.length,
    facetCount: {
      mkDifferentViewJudges: Object.fromEntries(
        judges.map((judge) => [judge, 1]),
      ),
      mkDefendant: { "Najvy\u0161\u0161\u00ed s\u00fad SR": 1 },
      mkPublicDefendant: {},
      mkViolator: {},
      mkFormOfProposer: { "Fyzick\u00e1 osoba": 1 },
      mkKindOfOtherProposer: {},
      mkFileNumberOfDefendantProceeding: {},
    },
  });

/**
 * Items shaped like the DMS actually answers: real document ids, the court's
 * own docket spelling, and its `MM/DD/YYYY HH:mm:ss` dates. A shortened stand-in
 * would let an identity or date rule pass here and fail on live traffic.
 */
const PLENARY_OPINION = {
  documentId: "7964d54e-6708-48e9-92cc-5cc400aab1e3",
  mkDocumentType: "Rozhodnutie - Nález",
  mkRSAPNumberOfFile: "PL. ÚS 4/2020",
  mkRVPNumberOfFile: "1448/2020",
  mkECLI: "ECLI:SK:USSR:2020:PL.US.4.2020.1",
  mkDateOfDecision: "03/12/2020 00:00:00",
  mkFormOfDecision: "Nález",
  mkJudgeReporter: "Ivan Fiačan",
} as const;

const CHAMBER_RESOLUTION = {
  documentId: "2d6903ee-0dd6-4281-8edc-8c814a52b0b1",
  mkDocumentType: "Rozhodnutie - Uznesenie z predbežného prerokovania",
  mkRSAPNumberOfFile: "I. ÚS 132/93",
  mkDateOfDecision: "12/15/1993 00:00:00",
  mkFormOfDecision: "Uznesenie",
} as const;

/** The DMS lists metadata rows with no downloadable document behind them. */
const WITHOUT_DOCUMENT_ID = {
  mkDocumentType: "Rozhodnutie - Uznesenie z predbežného prerokovania",
  mkRSAPNumberOfFile: "I. ÚS 132/93",
  mkDateOfDecision: "12/15/1993 00:00:00",
} as const;

type SearchBody = {
  start: number;
  pageSize: number;
  docType: string;
  searchFilter: {
    filterNameValue: {
      type: string;
      fieldName: string;
      fieldValue: { FROM: string; TO: string };
    }[];
  };
};

const parseSearchBody = (init: RequestInit | undefined): SearchBody => {
  const body: unknown = JSON.parse(
    typeof init?.body === "string" ? init.body : "{}",
  );
  // The mock feeds back exactly what the adapter serialized; the assertions
  // below are what actually check its shape.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test-local narrowing of the adapter's own request body
  return body as SearchBody;
};

const dateRangeOf = (body: SearchBody): { FROM: string; TO: string } => {
  const filter = body.searchFilter.filterNameValue.at(0);
  if (filter === undefined) {
    throw new Error("search body carried no filter");
  }
  return filter.fieldValue;
};

/** How the stubbed DMS answers one search request. */
type SearchStub =
  | {
      type: "page";
      documents: readonly Record<string, unknown>[];
      numFound: number;
    }
  /** A 2xx body the response validator has to judge on its own. */
  | { type: "body"; json: string }
  | { type: "status"; status: number };

/** How the stubbed document download answers. */
type DownloadStub =
  | { type: "pdf" }
  /** A 200 carrying the portal's error page instead of the document. */
  | { type: "not-a-pdf" }
  | { type: "status"; status: number };

type MockOptions = {
  /** Listing responses, one per request, in order. */
  search: readonly SearchStub[];
  /** Answers derived from the window asked for; takes precedence over `search`. */
  searchFor?: (body: SearchBody) => SearchStub;
  download?: DownloadStub;
  onSearch?: (body: SearchBody, headers: Headers) => void;
  /** Judges the per-docket facet query reports as dissenting. */
  dissenters?: readonly string[];
  /** Every supplementary surface answers nothing, as this service does under load. */
  supplementaryUnavailable?: boolean;
};

/**
 * Whether a search body is the crawl's listing query or the per-docket facet
 * query. Both go to the same endpoint; only the second narrows on the docket,
 * which is what makes the two countable apart.
 */
const isFacetQuery = (body: SearchBody): boolean =>
  body.searchFilter.filterNameValue.some(
    (filter) => filter.fieldName === "mkRSAPNumberOfFileNorm",
  );

/** A payload that opens like a real PDF; its body is not a parseable one. */
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\n");

const downloadResponse = (stub: DownloadStub): Response => {
  switch (stub.type) {
    case "pdf":
      return new Response(PDF_BYTES, {
        headers: { "Content-Type": "application/pdf" },
      });
    case "not-a-pdf":
      return new Response(
        "<html><body>Dokument nie je dostupný</body></html>",
        {
          headers: { "Content-Type": "text/html" },
        },
      );
    case "status":
      return new Response(null, { status: stub.status });
    default: {
      const exhaustive: never = stub;
      throw new Error(`unhandled download stub: ${JSON.stringify(exhaustive)}`);
    }
  }
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

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const searchResponse = (stub: SearchStub): Response => {
  switch (stub.type) {
    case "page":
      return new Response(
        JSON.stringify({ documents: stub.documents, numFound: stub.numFound }),
        { headers: JSON_HEADERS },
      );
    case "body":
      return new Response(stub.json, { headers: JSON_HEADERS });
    case "status":
      return new Response(stub.status === 204 ? null : "upstream failure", {
        status: stub.status,
      });
    default: {
      const exhaustive: never = stub;
      throw new Error(`unhandled search stub: ${JSON.stringify(exhaustive)}`);
    }
  }
};

type MockHandle = {
  /** Listing queries: the crawl's own cost, excluding the facet reads. */
  calls: () => number;
  downloads: () => number;
  facetCalls: () => number;
};

const mockFetch = ({
  dissenters = [],
  download = { type: "pdf" },
  onSearch,
  search,
  searchFor,
  supplementaryUnavailable = false,
}: MockOptions): MockHandle => {
  let searchCall = 0;
  let downloadCall = 0;
  let facetCall = 0;
  const unavailable = () => new Response(null, { status: 204 });
  globalThis.fetch = asFetchMock(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === SEARCH_PATH) {
        const body = parseSearchBody(init);
        if (isFacetQuery(body)) {
          facetCall += 1;
          return Promise.resolve(
            supplementaryUnavailable
              ? unavailable()
              : new Response(facetsBody(dissenters), { headers: JSON_HEADERS }),
          );
        }
        onSearch?.(body, new Headers(init?.headers));
        const next =
          searchFor?.(body) ??
          search.at(Math.min(searchCall, search.length - 1));
        searchCall += 1;
        return Promise.resolve(
          next === undefined
            ? new Response("no search response stubbed", { status: 500 })
            : searchResponse(next),
        );
      }
      if (url.pathname === CONTENT_PATH) {
        return Promise.resolve(
          supplementaryUnavailable
            ? unavailable()
            : new Response(
                JSON.stringify({
                  content: Buffer.from(DOCUMENT_XHTML).toString("base64"),
                }),
                { headers: JSON_HEADERS },
              ),
        );
      }
      if (url.pathname === CODELIST_PATH) {
        return Promise.resolve(
          supplementaryUnavailable
            ? unavailable()
            : new Response(CODELIST_BODY, { headers: JSON_HEADERS }),
        );
      }
      if (url.pathname.startsWith(COURT_FILE_PREFIX)) {
        return Promise.resolve(
          supplementaryUnavailable
            ? unavailable()
            : new Response(COURT_FILE_BODY, { headers: JSON_HEADERS }),
        );
      }
      if (url.pathname.startsWith(DOWNLOAD_PREFIX)) {
        downloadCall += 1;
        return Promise.resolve(downloadResponse(download));
      }
      return Promise.resolve(
        new Response(`unexpected request: ${url.toString()}`, { status: 500 }),
      );
    },
  );
  return {
    calls: () => searchCall,
    downloads: () => downloadCall,
    facetCalls: () => facetCall,
  };
};

describe("sk-us reconciliation slices", () => {
  beforeAll(() => {
    setSystemTime(new Date("2026-08-11T09:30:00.000Z"));
  });

  afterAll(() => {
    setSystemTime();
  });

  test("starts at the first month the API publishes for", () => {
    expect(reconciliation.firstSlice).toBe("1993-01");
    expect(SK_US_FIRST_SLICE).toBe(reconciliation.firstSlice);
  });

  test("slices a UTC instant to its calendar month", () => {
    expect(reconciliation.sliceOf(new Date("2026-01-31T23:59:59.999Z"))).toBe(
      "2026-01",
    );
    // A local-time month would answer 2026-01 here in any negative offset.
    expect(reconciliation.sliceOf(new Date("2026-02-01T00:00:00.000Z"))).toBe(
      "2026-02",
    );
  });

  test("steps across the year boundary in both directions", () => {
    expect(reconciliation.nextSlice("2020-12")).toBe("2021-01");
    expect(reconciliation.previousSlice("2021-01")).toBe("2020-12");
  });

  test("stops at the ends of the walk", () => {
    expect(reconciliation.previousSlice(SK_US_FIRST_SLICE)).toBeNull();
    expect(reconciliation.previousSlice("1993-02")).toBe(SK_US_FIRST_SLICE);
    // The tip is the current month; there is no slice past it to walk into.
    expect(reconciliation.nextSlice("2026-08")).toBeNull();
    expect(reconciliation.nextSlice("2026-07")).toBe("2026-08");
  });

  test("walk order is the ledger's lexicographic order", () => {
    let slice = SK_US_FIRST_SLICE;
    let walked = 0;
    // Bounded so a broken step cannot spin the suite; far above the ~400
    // months between the feed's first slice and the frozen clock.
    for (; walked < 1000; walked += 1) {
      const next = reconciliation.nextSlice(slice);
      if (next === null) {
        break;
      }
      // The ledger orders slices as plain strings, so every step forward must
      // also be a step up in byte order.
      expect(next > slice).toBe(true);
      expect(reconciliation.previousSlice(next)).toBe(slice);
      slice = next;
    }
    expect(slice).toBe(reconciliation.sliceOf(new Date()));
    expect(walked).toBe(403);
  });

  test("tip window is six months, newest first", () => {
    expect(tipWindowSlices(reconciliation, new Date())).toEqual([
      "2026-08",
      "2026-07",
      "2026-06",
      "2026-05",
      "2026-04",
      "2026-03",
    ]);
  });

  test("tip window truncates at the first slice for a young source", () => {
    expect(tipWindowSlices(reconciliation, new Date("1993-03-15T00:00:00Z"))) //
      .toEqual(["1993-03", "1993-02", "1993-01"]);
  });
});

describe("sk-us listing identity", () => {
  test("keys an item on the DMS document id, as the crawl stores it", () => {
    expect(skUsListingIdentity(PLENARY_OPINION)).toEqual({
      type: "document",
      sourceDocumentId: PLENARY_OPINION.documentId,
    });
    expect(listingIdentityKey(skUsListingIdentity(PLENARY_OPINION))).toBe(
      `document:${PLENARY_OPINION.documentId}`,
    );
  });

  test("a docket's documents are separate identities, as the store now is", () => {
    // The court publishes each opinion of a plenary decision as its own
    // document under one docket; keyed on the docket they were one row.
    const sibling = {
      ...PLENARY_OPINION,
      documentId: "9c2f0f01-6a2f-4a53-9a4e-2b6cf9a5f4d2",
    };
    expect(listingIdentityKey(skUsListingIdentity(sibling))).not.toBe(
      listingIdentityKey(skUsListingIdentity(PLENARY_OPINION)),
    );
  });

  test("an id the decision column cannot hold keys nothing", () => {
    expect(
      skUsListingIdentity({
        ...PLENARY_OPINION,
        documentId: "d".repeat(SOURCE_DOCUMENT_ID_MAX_LENGTH + 1),
      }),
    ).toEqual({ type: "unidentifiable" });
  });

  test("an item the crawl would drop is unidentifiable, not keyed on nothing", () => {
    expect(
      skUsListingIdentity({ ...CHAMBER_RESOLUTION, mkRSAPNumberOfFile: "" }),
    ).toEqual({ type: "unidentifiable" });
    expect(skUsListingIdentity(WITHOUT_DOCUMENT_ID)).toEqual({
      type: "unidentifiable",
    });
    expect(
      listingIdentityKey(skUsListingIdentity(WITHOUT_DOCUMENT_ID)),
    ).toBeNull();
  });
});

describe("sk-us listSlicePage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("asks the publisher for exactly the slice's month", async () => {
    const ranges: { FROM: string; TO: string }[] = [];
    const authHeaders: (string | null)[] = [];
    mockFetch({
      search: [{ type: "page", documents: [], numFound: 0 }],
      onSearch: (body, headers) => {
        ranges.push(dateRangeOf(body));
        authHeaders.push(headers.get("Authorization"));
        expect(body.docType).toBe("USSR_DECISION_MK");
        expect(body.pageSize).toBe(100);
      },
    });

    await reconciliation.listSlicePage({ slice: "2020-03", page: 0 });
    await reconciliation.listSlicePage({ slice: "2020-02", page: 2 });
    await reconciliation.listSlicePage({ slice: "2021-02", page: 0 });

    expect(ranges).toEqual([
      { FROM: "2020-03-01", TO: "2020-03-31" },
      // February's last day is derived, not assumed: a leap year and a
      // common one must not ask for the same window.
      { FROM: "2020-02-01", TO: "2020-02-29" },
      { FROM: "2021-02-01", TO: "2021-02-28" },
    ]);
    // The endpoint rejects a request carrying a token it cannot verify.
    expect(authHeaders).toEqual([null, null, null]);
  });

  test("pages a month by the listing page size", async () => {
    const starts: number[] = [];
    mockFetch({
      search: [{ type: "page", documents: [PLENARY_OPINION], numFound: 361 }],
      onSearch: (body) => {
        starts.push(body.start);
      },
    });

    const first = await reconciliation.listSlicePage({
      slice: "2026-06",
      page: 0,
    });
    const last = await reconciliation.listSlicePage({
      slice: "2026-06",
      page: 3,
    });

    expect(starts).toEqual([0, 300]);
    expect(first.totalPages).toBe(4);
    expect(last.totalPages).toBe(4);
    expect(first.items).toHaveLength(1);
    expect(first.items.at(0)?.identity).toEqual({
      type: "document",
      sourceDocumentId: PLENARY_OPINION.documentId,
    });
  });

  test("the parked payload is the listing item verbatim and JSON-replayable", async () => {
    mockFetch({
      search: [{ type: "page", documents: [PLENARY_OPINION], numFound: 1 }],
    });

    const { items } = await reconciliation.listSlicePage({
      slice: "2020-03",
      page: 0,
    });
    const payload: unknown = items.at(0)?.payload;
    // The loop parks this verbatim in JSONB and replays it days later.
    const serialized = JSON.stringify(payload);
    const parked: unknown = JSON.parse(serialized);

    expect(payload).toEqual(PLENARY_OPINION);
    expect(parked).toEqual(PLENARY_OPINION);
  });

  test("a month the publisher lists nothing for is an empty slice", async () => {
    mockFetch({ search: [{ type: "page", documents: [], numFound: 0 }] });

    expect(
      await reconciliation.listSlicePage({ slice: "1993-01", page: 0 }),
    ).toEqual({ items: [], totalPages: 0 });
  });

  test("a server error throws instead of reading as an empty slice", async () => {
    const stub = mockFetch({
      search: [{ type: "status", status: 500 }],
    });

    const rejection = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2026-06", page: 0 }),
    );

    expect(rejection).toBeInstanceOf(Error);
    // Retried once, then surfaced: a slice recorded empty during an outage
    // would settle and never be walked again.
    expect(stub.calls()).toBe(2);
  });

  // ── A record the DMS will not serialise ──────────────────
  //
  // 2025-04 states 278 decisions, and every window containing result index
  // 194 answers 204 with an empty body: start=193&pageSize=1 answers 200,
  // start=194&pageSize=1 answers 204, start=195&pageSize=1 answers 200.

  /** Result index the stubbed DMS refuses, exactly as 2025-04's does. */
  const UNSERVED_INDEX = 194;
  const POISONED_NUM_FOUND = 278;

  /**
   * What one refused page may cost: two requests per halving of the adapter's
   * 100-record listing page, the refused request that started it, and the one
   * that confirms the isolated record is refused rather than unlucky.
   */
  const SPLIT_REQUEST_BOUND = 2 * Math.ceil(Math.log2(100)) + 1 + 1;

  /**
   * What a window that serves nothing costs: one halving per level down the
   * spine, plus the two one-record windows at the bottom that establish it,
   * each of which is asked twice before it counts as refused.
   */
  const OUTAGE_REQUEST_COUNT = Math.ceil(Math.log2(100)) + 2 * 2;

  /** A DMS document for result index `index`, keyed the way the real ones are. */
  const documentAt = (index: number) => ({
    ...PLENARY_OPINION,
    documentId: `7964d54e-6708-48e9-92cc-5cc4${String(index).padStart(8, "0")}`,
    mkRSAPNumberOfFile: `III. ÚS ${index}/2025`,
    mkDateOfDecision: "04/15/2025 00:00:00",
  });

  /** The DMS as 2025-04's is: 204 for any window covering `UNSERVED_INDEX`. */
  const poisonedDms = ({
    pageSize,
    start,
  }: Pick<SearchBody, "start" | "pageSize">): SearchStub => {
    if (start <= UNSERVED_INDEX && UNSERVED_INDEX < start + pageSize) {
      return { type: "status", status: 204 };
    }
    const end = Math.min(start + pageSize, POISONED_NUM_FOUND);
    return {
      type: "page",
      documents: Array.from({ length: Math.max(0, end - start) }, (_, offset) =>
        documentAt(start + offset),
      ),
      numFound: POISONED_NUM_FOUND,
    };
  };

  test("an empty 204 throws rather than settling the slice", async () => {
    const stub = mockFetch({ search: [{ type: "status", status: 204 }] });

    const rejection = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2026-06", page: 0 }),
    );

    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "no body",
    );
    // A window that serves nothing however narrowly it is cut is the endpoint
    // being down, and is established by walking one spine of the halving
    // rather than by subdividing the whole page.
    expect(stub.calls()).toBe(OUTAGE_REQUEST_COUNT);
  }, 30_000);

  test("a record the DMS refuses is isolated, not allowed to refuse its page", async () => {
    // Without a split this page answers 204 whole and the month is held.
    expect(poisonedDms({ start: 100, pageSize: 100 })).toEqual({
      type: "status",
      status: 204,
    });

    const stub = mockFetch({ search: [], searchFor: poisonedDms });

    const page = await reconciliation.listSlicePage({
      slice: "2025-04",
      page: 1,
    });

    // The page is whole: 99 keyed records plus the one that cannot be keyed,
    // which the engine counts as unidentifiable and leaves out of both
    // `reported` and `collected`.
    expect(page.items).toHaveLength(100);
    expect(page.totalPages).toBe(3);
    const unkeyableAt = page.items.findIndex(
      ({ identity }) => listingIdentityKey(identity) === null,
    );
    // In place, not appended: the walk must not reorder what the publisher
    // lists, or a replay would key the wrong payloads.
    expect(unkeyableAt).toBe(UNSERVED_INDEX - 100);
    expect(page.items.at(unkeyableAt)?.identity).toEqual({
      type: "unidentifiable",
    });
    expect(
      page.items.filter(
        ({ identity }) => listingIdentityKey(identity) === null,
      ),
    ).toHaveLength(1);
    expect(stub.calls()).toBe(SPLIT_REQUEST_BOUND);
  }, 30_000);

  test("a page of a poisoned month that carries no refused record costs one request", async () => {
    const stub = mockFetch({ search: [], searchFor: poisonedDms });

    const page = await reconciliation.listSlicePage({
      slice: "2025-04",
      page: 0,
    });

    expect(page.items).toHaveLength(100);
    expect(stub.calls()).toBe(1);
  });

  test("a one-record 204 that does not repeat lists the record it named", async () => {
    // An unidentifiable item is excluded from the slice rather than parked, so
    // nothing retries it: a 204 the endpoint answered once under load and not
    // again would drop a real decision out of `reported` for good.
    let singletonCalls = 0;
    const transientDms = (
      body: Pick<SearchBody, "start" | "pageSize">,
    ): SearchStub => {
      const isTheRecord = body.start === UNSERVED_INDEX && body.pageSize === 1;
      if (!isTheRecord) {
        return poisonedDms(body);
      }
      singletonCalls += 1;
      return singletonCalls === 1
        ? { type: "status", status: 204 }
        : {
            type: "page",
            documents: [documentAt(UNSERVED_INDEX)],
            numFound: POISONED_NUM_FOUND,
          };
    };

    const stub = mockFetch({ search: [], searchFor: transientDms });

    const page = await reconciliation.listSlicePage({
      slice: "2025-04",
      page: 1,
    });

    // The record is asked for twice and served the second time, so it is a
    // listed decision like any other and nothing is unidentifiable.
    expect(singletonCalls).toBe(2);
    expect(page.items).toHaveLength(100);
    expect(
      page.items.filter(
        ({ identity }) => listingIdentityKey(identity) === null,
      ),
    ).toHaveLength(0);
    expect(page.items.at(UNSERVED_INDEX - 100)?.identity).toEqual({
      type: "document",
      sourceDocumentId: documentAt(UNSERVED_INDEX).documentId,
    });
    expect(stub.calls()).toBe(SPLIT_REQUEST_BOUND);
  }, 30_000);

  test("halves that disagree on the month's size throw rather than bank a page", async () => {
    // Both halves size the same month, so two counts mean the page cannot be
    // sized; keeping either would write a `reported` the slice never reaches.
    const stub = mockFetch({
      search: [
        { type: "status", status: 204 },
        { type: "page", documents: [PLENARY_OPINION], numFound: 200 },
        { type: "page", documents: [CHAMBER_RESOLUTION], numFound: 201 },
      ],
    });

    const rejection = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2025-04", page: 0 }),
    );

    expect(rejection).toBeInstanceOf(AdapterFetchError);
    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "200 and 201",
    );
    expect(stub.calls()).toBe(3);
  }, 30_000);

  test("a payload without a count throws rather than reporting zero pages", async () => {
    mockFetch({
      search: [{ type: "body", json: JSON.stringify({ documents: [] }) }],
    });

    expect(
      await rejectionOf(
        reconciliation.listSlicePage({ slice: "2026-06", page: 0 }),
      ),
    ).toBeInstanceOf(Error);
  });
});

describe("sk-us buildDecision", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("builds the decision the crawl would have stored", async () => {
    mockFetch({ search: [] });

    const outcome = await reconciliation.buildDecision(PLENARY_OPINION);

    expect(outcome.type).toBe("built");
    if (outcome.type !== "built") {
      return;
    }
    expect(outcome.decision.caseNumber).toBe("PL. ÚS 4/2020");
    expect(outcome.decision.language).toBe("sk");
    expect(outcome.decision.country).toBe("SVK");
    expect(outcome.decision.decisionDate).toBe("2020-03-12");
    expect(outcome.decision.documentUrl).toBe(
      "https://www.ustavnysud.sk/docDownload/7964d54e-6708-48e9-92cc-5cc400aab1e3",
    );
    expect(outcome.decision.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(outcome.decision.isListingOnly).toBeUndefined();
    // The file the court serves is binary, so the envelope names it instead
    // of holding it; the bytes are handed over for the pipeline to store.
    expect(outcome.decision.sourceRawBytes).toBeUndefined();
    expect(outcome.decision.sourceRawObjects?.["document-file"]?.bytes).toEqual(
      PDF_BYTES,
    );
  });

  test("every response the court served for the decision is in the envelope", async () => {
    mockFetch({ search: [], dissenters: ["Peter Straka"] });

    const outcome = await reconciliation.buildDecision(PLENARY_OPINION);
    if (outcome.type !== "built") {
      throw new Error(`expected a built decision, got ${outcome.type}`);
    }
    const parts = decodeSourceRawEnvelope(outcome.decision.sourceRaw ?? "");

    // The listing row is what names the decision, and before the envelope it
    // was the one response a decision with a document kept none of.
    expect(Object.keys(parts ?? {}).toSorted()).toEqual([
      "codelists",
      "document",
      "facets",
      "file",
      "listing",
    ]);
    expect(JSON.parse(parts?.["listing"] ?? "null")).toEqual(PLENARY_OPINION);
    expect(parts?.["document"]).toContain("rozh od ol");
    // The vocabularies are corpus-level, so the row keeps the digest of the
    // response it read and the entries this decision resolved against it.
    expect(JSON.parse(parts?.["codelists"] ?? "null")).toMatchObject({
      used: {
        mkJudgeReporter: ["Ivan Fiačan"],
        mkDifferentViewJudges: ["Peter Straka"],
      },
    });
  });

  test("the judges the source states structurally reach the row", async () => {
    mockFetch({ search: [], dissenters: ["Peter Straka"] });

    const outcome = await reconciliation.buildDecision(PLENARY_OPINION);
    if (outcome.type !== "built") {
      throw new Error(`expected a built decision, got ${outcome.type}`);
    }
    // The rapporteur is a field on the row; the dissenter is an index field
    // the row never carries and the facet query is the only statement of.
    expect(outcome.decision.judges).toEqual([
      { role: "rapporteur", nameAsPrinted: "Ivan Fiačan" },
      { role: "dissenting", nameAsPrinted: "Peter Straka" },
    ]);
  });

  test("a separate opinion's kind is the value the court sends, not its letters", async () => {
    mockFetch({ search: [] });

    const outcome = await reconciliation.buildDecision({
      ...PLENARY_OPINION,
      mkDifferentView: "Odlišné stanovisko iné",
    });
    if (outcome.type !== "built") {
      throw new Error(`expected a built decision, got ${outcome.type}`);
    }
    // The field is one value of a three-entry vocabulary. Read as a list it
    // deduplicates into the set of its own characters, which is what every
    // separate opinion ingested before this carried.
    expect(outcome.decision.metadata["dissentingOpinion"]).toBe(
      "Odlišné stanovisko iné",
    );
  });

  test("a petitioner kind reads the same whether the court sends one or several", async () => {
    mockFetch({ search: [] });

    const single = await reconciliation.buildDecision({
      ...PLENARY_OPINION,
      mkTypeOfProposer: "Fyzická osoba",
    });
    const several = await reconciliation.buildDecision({
      ...PLENARY_OPINION,
      mkTypeOfProposer: ["Iná", "Skupina poslancov NR SR"],
    });
    if (single.type !== "built" || several.type !== "built") {
      throw new Error("expected both decisions to build");
    }
    expect(single.decision.metadata["typeOfProposer"]).toEqual([
      "Fyzická osoba",
    ]);
    expect(several.decision.metadata["typeOfProposer"]).toEqual([
      "Iná",
      "Skupina poslancov NR SR",
    ]);
  });

  test("the docket file answers what the decision row leaves empty", async () => {
    mockFetch({ search: [] });

    const outcome = await reconciliation.buildDecision(PLENARY_OPINION);
    if (outcome.type !== "built") {
      throw new Error(`expected a built decision, got ${outcome.type}`);
    }
    // Neither is on a decision row: the date the petition reached the court
    // and the files it refers to are stated on the docket file alone.
    expect(outcome.decision.metadata["entryDate"]).toBe("2020-06-30");
    expect(outcome.decision.metadata["references"]).toEqual(["2196/2020"]);
  });

  test("a decision the supplementary surfaces answer nothing for still builds", async () => {
    mockFetch({ search: [], supplementaryUnavailable: true });

    const outcome = await reconciliation.buildDecision(PLENARY_OPINION);
    if (outcome.type !== "built") {
      throw new Error(`expected a built decision, got ${outcome.type}`);
    }
    // A surface the service will not serve leaves its part out rather than
    // halting the crawl: the listing row still names the decision, and the
    // envelope states exactly what arrived.
    expect(
      Object.keys(
        decodeSourceRawEnvelope(outcome.decision.sourceRaw ?? "") ?? {},
      ),
    ).toEqual(["listing"]);
  });

  test("the identity the walk keys is the identity the build stores", async () => {
    mockFetch({ search: [] });

    const outcome = await reconciliation.buildDecision(PLENARY_OPINION);
    expect(outcome.type).toBe("built");
    if (outcome.type !== "built") {
      return;
    }
    // Silent drift here is the whole failure mode: a walk that keys an item
    // one way and a build that stores it another leaves the slice permanently
    // short and re-fetches the same document forever.
    expect(
      listingIdentityKey({
        type: "document",
        sourceDocumentId: outcome.decision.sourceDocumentId ?? "",
      }),
    ).toBe(listingIdentityKey(skUsListingIdentity(PLENARY_OPINION)));
  });

  test("the built decision carries the URL its docket-keyed row was stored under", async () => {
    mockFetch({ search: [] });

    const outcome = await reconciliation.buildDecision(PLENARY_OPINION);
    expect(outcome.type).toBe("built");
    if (outcome.type !== "built") {
      return;
    }
    // The hint the pipeline re-keys an existing null-id row by: it must be the
    // URL that row carries, which is the one this build stores as `sourceUrl`.
    expect(outcome.decision.legacySourceUrls).toEqual([
      outcome.decision.sourceUrl ?? "",
    ]);
    expect(outcome.decision.sourceUrl).toBe(
      `https://www.ustavnysud.sk/docDownload/${PLENARY_OPINION.documentId}`,
    );
  });

  test("a document the court does not serve is never written", async () => {
    mockFetch({ search: [], download: { type: "status", status: 404 } });

    expect(await reconciliation.buildDecision(CHAMBER_RESOLUTION)).toEqual({
      type: "detail-unavailable",
    });
  });

  test("the marker the crawl stores is what makes heldness require detail", async () => {
    mockFetch({ search: [], download: { type: "status", status: 404 } });

    // Two halves of one decision, asserted together because either alone is
    // silently wrong. The crawl keeps the row the reconciliation refuses and
    // marks it `isListingOnly`; the capability declares that such a row is not
    // held. Drop the marker and the declaration filters nothing; drop the
    // declaration and the marked row reads as held, the slice reads reconciled,
    // and the court is never asked for that document again.
    expect(await buildSkUsDecision(CHAMBER_RESOLUTION)).toMatchObject({
      type: "detail-unavailable",
      decision: { isListingOnly: true },
    });
    expect(reconciliation.heldRequiresDetail).toBe(true);
  });

  test("a 200 that is not a PDF is no document either", async () => {
    mockFetch({ search: [], download: { type: "not-a-pdf" } });

    // The portal answers a missing document with an error page under a 200.
    // Kept apart from a PDF this parser cannot read: those bytes are the
    // decision and are stored for re-parsing, an error page never is.
    expect(await reconciliation.buildDecision(CHAMBER_RESOLUTION)).toEqual({
      type: "detail-unavailable",
    });
  });

  test("a payload that no longer states an identity is unkeyable", async () => {
    mockFetch({ search: [] });

    expect(await reconciliation.buildDecision({})).toEqual({
      type: "unkeyable",
    });
    expect(
      await reconciliation.buildDecision({
        ...PLENARY_OPINION,
        mkRSAPNumberOfFile: "",
      }),
    ).toEqual({ type: "unkeyable" });
    // A field whose type the DMS changed under us keys nothing either.
    expect(
      await reconciliation.buildDecision({ ...PLENARY_OPINION, documentId: 7 }),
    ).toEqual({ type: "unkeyable" });
  });

  test("replays a payload that round-tripped through storage", async () => {
    mockFetch({
      search: [{ type: "page", documents: [PLENARY_OPINION], numFound: 1 }],
    });
    const { items } = await reconciliation.listSlicePage({
      slice: "2020-03",
      page: 0,
    });
    const serialized = JSON.stringify(items.at(0)?.payload ?? null);
    const parked: unknown = JSON.parse(serialized);

    const outcome = await reconciliation.buildDecision(parked);

    expect(outcome.type).toBe("built");
  });
});

describe("sk-us crawl and reconciliation dispose of a missing document differently", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test("the crawl keeps the listing-only row the reconciliation refuses", async () => {
    mockFetch({ search: [], download: { type: "status", status: 404 } });

    const built = await buildSkUsDecision(CHAMBER_RESOLUTION);

    expect(built.type).toBe("detail-unavailable");
    if (built.type !== "detail-unavailable") {
      return;
    }
    // The crawl's cursor moves past this document either way, so it stores
    // what the listing proves — flagged, so a later refresh cannot overwrite
    // detail a successful fetch recovered.
    expect(built.decision.caseNumber).toBe("I. ÚS 132/93");
    expect(built.decision.isListingOnly).toBe(true);
    expect(built.decision.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
  });
});

/**
 * The service answers every key on every row and sends `null` for an empty
 * one, and the three list-valued keys arrive as one value on some rows and
 * several on others. The crawl and the reconciliation build through the same
 * function, and both are driven here: the crawl drops an item it cannot build,
 * so only a count of what it kept shows a build that fails on every row.
 */
describe("sk-us rows as the court sends them", () => {
  const originalFetch = globalThis.fetch;
  const FIXTURES = new URL("__fixtures__/", import.meta.url);

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const recordedRows = async (): Promise<Record<string, unknown>[]> => {
    const page = await readGzipJson(new URL("sk-us-listing.json.gz", FIXTURES));
    const documents = isRecord(page) ? page["documents"] : undefined;
    if (!Array.isArray(documents)) {
      throw new TypeError("the recorded listing carries no documents");
    }
    return documents.filter(isRecord);
  };

  const LIST_FIELDS = [
    ["mkComplainedLegalRegulation", "challengedLegislation"],
    ["mkClarificationOfLegalRegulation", "clarificationOfLegalRegulation"],
    ["mkTypeOfProposer", "typeOfProposer"],
  ] as const;

  const withListFields = (value: unknown): Record<string, unknown> => ({
    ...PLENARY_OPINION,
    ...Object.fromEntries(LIST_FIELDS.map(([key]) => [key, value])),
  });

  test("every recorded row builds on the reconciliation path", async () => {
    mockFetch({ search: [] });
    const rows = await recordedRows();
    // The recording states `null` for a rapporteur and for every list key on
    // some row, which is what the fixture has to carry to reach the fault.
    expect(rows.some((row) => row["mkJudgeReporter"] === null)).toBe(true);
    expect(rows.every((row) => row["mkTypeOfProposer"] === null)).toBe(true);

    const types: string[] = [];
    for (const row of rows) {
      types.push((await reconciliation.buildDecision(row)).type);
    }

    expect(types).toEqual(rows.map(() => "built"));
  });

  test("every recorded row builds on the crawl", async () => {
    const rows = await recordedRows();
    mockFetch({
      search: [{ type: "page", documents: rows, numFound: rows.length }],
    });

    const result = await skUsAdapter.fetchPage("2021:0", {});

    expect(result.unwrap().decisions).toHaveLength(rows.length);
  });

  test.each([
    ["absent", undefined, []],
    ["null", null, []],
    ["one value", "Fyzická osoba", ["Fyzická osoba"]],
    [
      "several values",
      ["Iná", "Skupina poslancov NR SR"],
      ["Iná", "Skupina poslancov NR SR"],
    ],
  ])("a list key sent %s reads as a list", async (_shape, value, expected) => {
    mockFetch({ search: [] });

    const built = await buildSkUsDecision(withListFields(value));
    const reconciled = await reconciliation.buildDecision(
      withListFields(value),
    );

    if (built.type !== "built" || reconciled.type !== "built") {
      throw new Error("expected both paths to build");
    }
    for (const [, stored] of LIST_FIELDS) {
      expect(built.decision.metadata[stored]).toEqual(expected);
      expect(reconciled.decision.metadata[stored]).toEqual(expected);
    }
  });

  // The reconciliation engine parks a failed item under `errorTag(error)`; a
  // shape the adapter cannot read must name the field, not a spread.
  test.each([
    ["an object", { value: "Fyzická osoba" }],
    ["a number", 7],
    ["a list holding a non-string", ["Iná", null]],
  ])(
    "a list key sent as %s is refused as that field",
    async (_shape, value) => {
      mockFetch({ search: [] });

      for (const [key] of LIST_FIELDS) {
        const row = { ...PLENARY_OPINION, [key]: value };
        for (const thrown of [
          await rejectionOf(buildSkUsDecision(row)),
          await rejectionOf(reconciliation.buildDecision(row)),
        ]) {
          expect(thrown).toBeInstanceOf(UnpersistableDecisionFieldError);
          expect(errorTag(thrown)).toBe("UnpersistableDecisionFieldError");
          expect(
            thrown instanceof UnpersistableDecisionFieldError
              ? thrown.field
              : undefined,
          ).toBe(UNPERSISTABLE_DECISION_FIELDS.VALUE_LIST);
        }
      }
    },
  );
});

/**
 * What the steady-state crawl costs the court once the current year is listed
 * to its end.
 *
 * The cursor used to park at the offset the tail started from, so every cycle
 * re-listed that tail and re-downloaded a PDF for each decision on it — work
 * that wrote nothing, forever. The arithmetic below is the whole change: a
 * cycle the court added nothing to spends one search request, and a cycle that
 * collects documents leaves the cursor past them.
 */
describe("the sk-us steady-state frontier", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    setSystemTime(new Date("2026-08-11T09:30:00.000Z"));
  });

  afterAll(() => {
    setSystemTime();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Where the crawl parked after listing the current year to its end. */
  const PARKED_OFFSET = 120;
  const PARKED_CURSOR = `2026:${PARKED_OFFSET}`;

  /** What the court states the year held when the cursor last moved. */
  const YEAR_NUM_FOUND = 123;

  /** Three decisions the court published since then. */
  const newDocument = (index: number) => ({
    ...PLENARY_OPINION,
    documentId: `7964d54e-6708-48e9-92cc-5cc40000000${index}`,
    mkRSAPNumberOfFile: `III. ÚS ${index + 1}/2026`,
    mkDateOfDecision: "08/10/2026 00:00:00",
  });
  const NEW_DOCUMENTS = [newDocument(0), newDocument(1), newDocument(2)];

  const fetchPageAt = async (cursor: string | null) => {
    const result = await skUsAdapter.fetchPage(cursor, {});
    if (result.isErr()) {
      throw result.error;
    }
    return result.unwrap();
  };

  test("a cycle the court added nothing to costs one search and no downloads", async () => {
    const starts: number[] = [];
    const stub = mockFetch({
      search: [{ type: "page", documents: [], numFound: YEAR_NUM_FOUND }],
      onSearch: (body) => {
        starts.push(body.start);
      },
    });

    const page = await fetchPageAt(PARKED_CURSOR);

    expect(stub.calls()).toBe(1);
    expect(stub.downloads()).toBe(0);
    expect(starts).toEqual([PARKED_OFFSET]);
    expect(page.decisions).toHaveLength(0);
    expect(page.nextCursor).toBe(PARKED_CURSOR);
  });

  test("a cycle that collects three decisions costs one search and three downloads", async () => {
    const stub = mockFetch({
      search: [
        {
          type: "page",
          documents: NEW_DOCUMENTS,
          numFound: YEAR_NUM_FOUND + NEW_DOCUMENTS.length,
        },
      ],
    });

    const page = await fetchPageAt(PARKED_CURSOR);

    expect(stub.calls()).toBe(1);
    expect(stub.downloads()).toBe(NEW_DOCUMENTS.length);
    expect(page.decisions).toHaveLength(NEW_DOCUMENTS.length);
    // The cursor stops where the listing stopped, not where it started.
    expect(page.nextCursor).toBe(
      `2026:${PARKED_OFFSET + NEW_DOCUMENTS.length}`,
    );
    expect(page.nextCursor).not.toBe(PARKED_CURSOR);
  });

  test("the cycle after a collection stands still instead of re-downloading it", async () => {
    const stub = mockFetch({
      search: [],
      searchFor: ({ start }) => ({
        type: "page",
        documents: start === PARKED_OFFSET ? NEW_DOCUMENTS : [],
        numFound: YEAR_NUM_FOUND + NEW_DOCUMENTS.length,
      }),
    });

    const collecting = await fetchPageAt(PARKED_CURSOR);
    const quiet = await fetchPageAt(collecting.nextCursor);

    // The point of the frontier: those three PDFs are paid for once, and the
    // next cycle spends a single search request to learn there is nothing
    // behind them.
    expect(stub.calls()).toBe(2);
    expect(stub.downloads()).toBe(NEW_DOCUMENTS.length);
    expect(quiet.decisions).toHaveLength(0);
    expect(quiet.nextCursor).toBe(collecting.nextCursor);
  });
});

/**
 * What the court actually served, against what this adapter says it serves.
 *
 * The suites above drive the adapter with payloads shaped like the
 * publisher's. These read the publisher's own bytes: one recorded response
 * per surface the census declares stored. A key the service adds, a facet
 * it stops answering, a vocabulary it renames all reach this file as a
 * failure rather than as an inventory that quietly stops being total.
 */
describe("the responses this court served, as recorded", () => {
  const FIXTURES = new URL("__fixtures__/", import.meta.url);

  const readJsonGz = async (name: string): Promise<Record<string, unknown>> => {
    const payload = await readGzipJson(new URL(name, FIXTURES));
    if (!isRecord(payload)) {
      throw new TypeError(`${name} is not a JSON object`);
    }
    return payload;
  };

  test("every key the search row carries has a disposition", async () => {
    const page = await readJsonGz("sk-us-listing.json.gz");
    const documents = page["documents"];
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new Error("the recorded listing carries no documents");
    }

    const { fields } = skUsAdapter.sourceFields;
    const undeclared = [
      ...new Set(
        documents.flatMap((document) =>
          isRecord(document) ? Object.keys(document) : [],
        ),
      ),
    ].filter((key) => fields[key] === undefined);

    expect(undeclared).toEqual([]);
  });

  test("the facet query answers exactly the index fields this adapter asks for", async () => {
    const facets = await readJsonGz("sk-us-facets.json.gz");
    const counts = facets["facetCount"];
    if (!isRecord(counts)) {
      throw new Error("the recorded facet response states no counts");
    }

    const { fields } = skUsAdapter.sourceFields;
    expect(
      Object.keys(counts).filter((key) => fields[key] === undefined),
    ).toEqual([]);
    // The separate-opinion judges are the reason this query exists: no
    // projection ever carries them, whatever `fieldsToReturn` asks for.
    expect(Object.keys(counts["mkDifferentViewJudges"] ?? {})).not.toEqual([]);
  });

  test("the docket file states the filing date no decision row carries", async () => {
    const file = await readJsonGz("sk-us-file.json.gz");
    const documents = file["documents"];
    if (!Array.isArray(documents)) {
      throw new TypeError("the recorded docket file carries no documents");
    }
    const header = documents.find(
      (document) =>
        isRecord(document) && document["docType"] === "USSR_COURTFILE",
    );

    expect(isRecord(header) ? header["mkEntryDate"] : undefined).toBeTruthy();
    // The publisher's own grouping of a docket: the header plus the
    // documents filed under it, which is stronger than grouping by docket.
    expect(documents.length).toBeGreaterThan(1);
  });

  test("the vocabularies still name the two judge rosters", async () => {
    const payload = await readJsonGz("sk-us-codelist.json.gz");
    const codelist = payload["codelist"];
    if (!isRecord(codelist)) {
      throw new TypeError("the recorded vocabularies state no codelist");
    }

    for (const name of ["mkJudgeReporter", "mkDifferentViewJudges"]) {
      const roster = codelist[name];
      expect(Array.isArray(roster) ? roster.length : 0).toBeGreaterThan(0);
    }
  });

  test("the document the service renders is the text, and the file is bytes", async () => {
    const content = await readJsonGz("sk-us-content.json.gz");
    const encoded = content["content"];
    if (typeof encoded !== "string") {
      throw new TypeError("the recorded document states no content");
    }
    const xhtml = Buffer.from(encoded, "base64").toString("utf-8");
    const file = Bun.gunzipSync(
      new Uint8Array(
        await Bun.file(
          new URL("sk-us-decision.pdf.gz", FIXTURES).pathname,
        ).arrayBuffer(),
      ),
    );

    // Two renderings of one decision. The markup is what the parser reads;
    // the file is kept for what a later reader may want it for, and the
    // envelope names it by a digest over these exact bytes.
    expect(xhtml).toContain("PL. ÚS 11/2021");
    expect(new TextDecoder().decode(file.subarray(0, 5))).toBe("%PDF-");
  });
});
