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
import { tipWindowSlices } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import {
  listingIdentityKey,
  SOURCE_DOCUMENT_ID_MAX_LENGTH,
} from "@/api/lib/legal-search/ingestion-types";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const { reconciliation } = skUsAdapter;
if (reconciliation === undefined) {
  throw new Error("sk-us must declare a reconciliation capability");
}

const SEARCH_PATH = "/o/v1/dms/search";
const DOWNLOAD_PREFIX = "/docDownload/";

/**
 * Items shaped like the DMS actually answers: real document ids, the court's
 * own docket spelling, and its `MM/DD/YYYY HH:mm:ss` dates. A shortened stand-in
 * would let an identity or date rule pass here and fail on live traffic.
 */
const PLENARY_OPINION = {
  documentId: "7964d54e-6708-48e9-92cc-5cc400aab1e3",
  mkDocumentType: "Rozhodnutie - Nález",
  mkRSAPNumberOfFile: "PL. ÚS 4/2020",
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
  /** Search responses, one per request, in order. */
  search: readonly SearchStub[];
  download?: DownloadStub;
  onSearch?: (body: SearchBody, headers: Headers) => void;
};

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

const mockFetch = ({
  download = { type: "pdf" },
  onSearch,
  search,
}: MockOptions): { calls: () => number } => {
  let searchCall = 0;
  globalThis.fetch = asFetchMock(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === SEARCH_PATH) {
        onSearch?.(parseSearchBody(init), new Headers(init?.headers));
        const next = search.at(Math.min(searchCall, search.length - 1));
        searchCall += 1;
        return Promise.resolve(
          next === undefined
            ? new Response("no search response stubbed", { status: 500 })
            : searchResponse(next),
        );
      }
      if (url.pathname.startsWith(DOWNLOAD_PREFIX)) {
        return Promise.resolve(downloadResponse(download));
      }
      return Promise.resolve(
        new Response(`unexpected request: ${url.toString()}`, { status: 500 }),
      );
    },
  );
  return { calls: () => searchCall };
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

  test("an empty 204 throws rather than settling the slice", async () => {
    mockFetch({ search: [{ type: "status", status: 204 }] });

    const rejection = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2026-06", page: 0 }),
    );

    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "no body",
    );
  });

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
    expect(outcome.decision.sourceRawContentType).toBe("application/pdf");
    expect(outcome.decision.isListingOnly).toBeUndefined();
    // A PDF this parser cannot read is still the document: the bytes are kept
    // verbatim, so recovering its text is a re-parse of what was stored rather
    // than another download of the same payload.
    expect(outcome.decision.sourceRawBytes).toEqual(PDF_BYTES);
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
    expect(built.decision.fulltext).toBeUndefined();
    expect(built.decision.sourceRawContentType).toBe("application/json");
  });
});
