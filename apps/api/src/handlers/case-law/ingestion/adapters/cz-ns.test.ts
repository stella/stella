import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  buildCzNsDecision,
  czNsAdapter,
  type CzNsListingRow,
} from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { PublisherPageError } from "@/api/handlers/case-law/ingestion/adapters/publisher-page";
import { recaptureDecisionFromListing } from "@/api/handlers/case-law/ingestion/recapture";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { isReadRefusal } from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
  decodeSourceRawEnvelope,
  type IngestionResult,
  type StoredRawReparseInput,
} from "@/api/lib/legal-search/ingestion-types";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetchState = createTestFetch();

describe("Domino listings distinguish publisher refusal from an empty view", () => {
  afterEach(() => {
    testFetchState.restore();
    mock.restore();
  });

  for (const body of [
    "<html><form><input type='password'></form></html>",
    "{}",
    '{"viewentry":[]}',
    '{"@toplevelentries":"1"}',
    '{"@toplevelentries":',
    "",
  ]) {
    test(`rejects an unreadable page ${JSON.stringify(body)}`, async () => {
      testFetchState.set(
        asFetchMock(mock(asFetchMock(async () => new Response(body)))),
      );
      const page = await czNsAdapter.fetchPage("1", {});
      expect(page.isErr()).toBe(true);
      if (page.isErr()) {
        expect(page.error).toBeInstanceOf(PublisherPageError);
      }
    });
  }

  for (const member of [
    null,
    "invalid",
    { "@unid": 123 },
    { entrydata: [{ text: 42 }] },
  ]) {
    test(`isolates malformed member ${JSON.stringify(member)} from the listing envelope`, async () => {
      testFetchState.set(
        asFetchMock(
          mock(
            asFetchMock(
              async (url: string | URL | Request) =>
                new Response(
                  (url instanceof Request ? url.url : url.toString()).includes(
                    "ReadViewEntries",
                  )
                    ? JSON.stringify({
                        "@toplevelentries": "2",
                        viewentry: [
                          member,
                          {
                            "@unid": "0123456789abcdef0123456789abcdef",
                            entrydata: [
                              {
                                "@name": "znacka",
                                text: { "0": "1 Cdo 1/2026" },
                              },
                            ],
                          },
                        ],
                      })
                    : "<html><body><p>Rozhodnutí soudu.</p></body></html>",
                ),
            ),
          ),
        ),
      );
      const page = (await czNsAdapter.fetchPage("1", {})).unwrap();
      expect(page.nextCursor).toBe("3");
      expect(page.itemBuildFailures).toEqual({
        type: "item_build_failed",
        count: 1,
      });
      expect(page.decisions).toHaveLength(1);
      expect(page.decisions.at(0)?.sourceDocumentId).toBe(
        "0123456789abcdef0123456789abcdef",
      );
    });
  }

  test("accepts the publisher's explicit small empty view", async () => {
    testFetchState.set(
      asFetchMock(
        mock(asFetchMock(async () => new Response('{"@toplevelentries":"0"}'))),
      ),
    );
    const page = await czNsAdapter.fetchPage("1", {});
    expect(page.isOk()).toBe(true);
    if (page.isOk()) {
      expect(page.value.decisions).toEqual([]);
      expect(page.value.nextCursor).toBe("1");
    }
  });
});

describe("decision pages the publisher did not serve", () => {
  afterEach(() => {
    testFetchState.restore();
    mock.restore();
  });

  const UNID = "0123456789abcdef0123456789abcdef";
  const ROW = { unid: UNID, caseNumber: "1 Cdo 1/2026" };
  const PAGE = "<html><body><p>Rozhodnutí soudu.</p></body></html>";

  /** Answers that fail a read without stating that the page is absent. */
  const READ_FAILURES = {
    "a server error": () => new Response("", { status: 500 }),
    "a request timeout": () => {
      throw new DOMException("request deadline", "TimeoutError");
    },
    "an empty 204": () => new Response(null, { status: 204 }),
    "an empty 200 body": () => new Response(""),
  } as const satisfies Record<string, () => Response>;

  /**
   * Serve the listing, detail and print pages, answering every request whose
   * URL contains `failing` with `answer`.
   */
  const serveWith = (failing: string, answer: () => Response) => {
    testFetchState.set(
      asFetchMock(
        mock(
          asFetchMock(async (input: string | URL | Request) => {
            const url = input instanceof Request ? input.url : input.toString();
            if (url.includes(failing)) {
              return await Promise.resolve().then(answer);
            }
            return new Response(
              url.includes("ReadViewEntries")
                ? JSON.stringify({
                    "@toplevelentries": "1",
                    viewentry: [
                      {
                        "@unid": UNID,
                        entrydata: [
                          { "@name": "znacka", text: { "0": ROW.caseNumber } },
                        ],
                      },
                    ],
                  })
                : PAGE,
            );
          }),
        ),
      ),
    );
  };

  for (const [failure, answer] of Object.entries(READ_FAILURES)) {
    test(`a print page answering ${failure} is reported unread, never built without its AST`, async () => {
      serveWith("/WebPrint/", answer);

      const built = await buildCzNsDecision(ROW);

      expect(built).toMatchObject({
        type: "detail-unavailable",
        page: "print",
        read: { type: "unavailable" },
      });
    });
  }

  for (const failure of ["an empty 204", "an empty 200 body"] as const) {
    test(`a detail page answering ${failure} is reported unread`, async () => {
      serveWith("/WebSearch/", READ_FAILURES[failure]);

      const built = await buildCzNsDecision(ROW);

      expect(built).toMatchObject({
        type: "detail-unavailable",
        page: "detail",
        read: { type: "unavailable" },
      });
    });
  }

  test("the crawl stores nothing for an entry whose print read failed and moves past it", async () => {
    serveWith("/WebPrint/", READ_FAILURES["a server error"]);

    const page = (await czNsAdapter.fetchPage("1", {})).unwrap();

    expect(page.decisions).toEqual([]);
    expect(page.nextCursor).toBe("2");
    expect(page.itemBuildFailures).toEqual({
      type: "item_build_failed",
      count: 1,
    });
  });

  test("a print page the publisher has none of still builds the decision", async () => {
    serveWith("/WebPrint/", () => new Response("", { status: 404 }));

    const built = await buildCzNsDecision(ROW);

    expect(built.type).toBe("built");
  });

  for (const status of [401, 403] as const) {
    test(`a print page answering ${status} is reported as the document refused`, async () => {
      serveWith("/WebPrint/", () => new Response("", { status }));

      const built = await buildCzNsDecision(ROW);

      expect(built).toMatchObject({
        type: "detail-unavailable",
        page: "print",
        read: { type: "refused", status, scope: "document" },
      });
      expect(
        built.type === "detail-unavailable" && isReadRefusal(built.read),
      ).toBe(true);
    });

    test(`a detail page answering ${status} is reported as the document refused`, async () => {
      serveWith("/WebSearch/", () => new Response("", { status }));

      expect(await buildCzNsDecision(ROW)).toMatchObject({
        type: "detail-unavailable",
        page: "detail",
        read: { type: "refused", status, scope: "document" },
      });
    });

    test(`the crawl moves past an entry whose detail page answers ${status}`, async () => {
      serveWith("/WebSearch/", () => new Response("", { status }));

      const page = (await czNsAdapter.fetchPage("1", {})).unwrap();

      expect(page.decisions).toEqual([]);
      expect(page.nextCursor).toBe("2");
      expect(page.itemBuildFailures).toEqual({
        type: "item_build_failed",
        count: 1,
      });
    });

    test(`a listing answering ${status} stops the source as a publisher refusal`, async () => {
      serveWith("ReadViewEntries", () => new Response("", { status }));

      const page = await czNsAdapter.fetchPage("1", {});

      expect(page.isErr()).toBe(true);
      expect(
        page.isErr() &&
          page.error instanceof AdapterFetchError &&
          page.error.stopKind,
      ).toBe("publisher_refusal");
    });
  }

  test("a detail page the publisher has none of is reported as absent", async () => {
    serveWith("/WebSearch/", () => new Response("", { status: 404 }));

    expect(await buildCzNsDecision(ROW)).toEqual({
      type: "detail-unavailable",
      page: "detail",
      read: { type: "absent", evidence: "http-404" },
    });
  });
});

describe("the source hash fingerprints every stored part", () => {
  afterEach(() => {
    testFetchState.restore();
    mock.restore();
  });

  const UNID = "fedcba9876543210fedcba9876543210";
  const PAGE = "<html><body><p>Rozhodnutí soudu.</p></body></html>";

  const built = async (row: CzNsListingRow) => {
    testFetchState.set(
      asFetchMock(
        mock(
          asFetchMock(async () => await Promise.resolve(new Response(PAGE))),
        ),
      ),
    );
    const result = await buildCzNsDecision(row);
    testFetchState.restore();
    mock.restore();
    if (result.type !== "built") {
      throw new TypeError("Expected the served pages to build a decision");
    }
    return result.decision;
  };

  test("the hash is the fingerprint of the detail, print and listing parts", async () => {
    const decision = await built({ unid: UNID, caseNumber: "1 Cdo 1/2026" });
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");

    expect(Object.keys(parts ?? {}).toSorted()).toEqual([
      "detail",
      "listing",
      "print",
    ]);
    expect(decision.rawHash).toBe(
      sourceFingerprint({ sourceRaw: decision.sourceRaw ?? "" }),
    );
  });

  test("a docket the publisher adds to the same document moves the hash", async () => {
    const alone = await built({ unid: UNID, caseNumber: "1 Cdo 1/2026" });
    const joined = await built({
      unid: UNID,
      caseNumber: "1 Cdo 1/2026",
      additionalCaseNumbers: ["1 Cdo 2/2026"],
    });

    expect(joined.rawHash).not.toBe(alone.rawHash);
  });

  test("a listing row parked through JSONB keeps the hash", async () => {
    const direct = await built({
      unid: UNID,
      caseNumber: "1 Cdo 1/2026",
      additionalCaseNumbers: ["1 Cdo 2/2026"],
    });
    const reordered = await built({
      additionalCaseNumbers: ["1 Cdo 2/2026"],
      caseNumber: "1 Cdo 1/2026",
      unid: UNID,
    });

    expect(reordered.rawHash).toBe(direct.rawHash);
  });

  test("a replay of the stored payload reproduces the crawl's hash", async () => {
    const decision = await built({ unid: UNID, caseNumber: "1 Cdo 1/2026" });
    const reparse = czNsAdapter.reparseStoredRaw;
    if (reparse === undefined) {
      throw new TypeError("Expected cz-ns to implement stored-raw replay");
    }
    testFetchState.set(
      asFetchMock(
        mock(
          asFetchMock(() => {
            throw new TypeError(
              "Stored-raw replay must not contact the publisher",
            );
          }),
        ),
      ),
    );

    const replayed = await reparse({
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
    } satisfies StoredRawReparseInput);

    expect(replayed.type).toBe("parsed");
    if (replayed.type !== "parsed") {
      return;
    }
    expect(replayed.result.rawHash).toBe(decision.rawHash);
  });
});

describe("the judge a decision is signed by", () => {
  afterEach(() => testFetchState.restore());

  test("is the name, without the layout spaces and the signature mark the print prints", async () => {
    const print = new TextDecoder().decode(
      Bun.gunzipSync(
        await Bun.file(
          new URL(
            "../parsers/__fixtures__/cz-ns-29-odo-231-2002.print.html.gz",
            import.meta.url,
          ),
        ).bytes(),
      ),
    );
    testFetchState.set(
      asFetchMock(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        return await Promise.resolve(
          new Response(
            url.includes("/WebPrint/")
              ? print
              : "<html><body><p>Rozhodnutí soudu.</p></body></html>",
          ),
        );
      }),
    );

    const built = await buildCzNsDecision({
      unid: "0123456789abcdef0123456789abcdef",
      caseNumber: "29 Odo 231/2002",
    });

    expect(built.type).toBe("built");
    if (built.type !== "built") {
      return;
    }
    expect(built.decision.metadata).toMatchObject({
      judge: "JUDr. Zdeněk Krčmář",
    });
  });
});

describe("a row the court lists without its stored identity is recaptured by docket", () => {
  afterEach(() => testFetchState.restore());

  const DOCKET = "29 Odo 231/2002";
  const LISTED_ROW: CzNsListingRow = {
    unid: "D4CD5035BC65D179C1257A4E0066A9A2",
    caseNumber: DOCKET,
  };
  const fixture = async (path: string): Promise<string> =>
    new TextDecoder().decode(
      Bun.gunzipSync(await Bun.file(new URL(path, import.meta.url)).bytes()),
    );
  const pages = async () => ({
    web: await fixture("__fixtures__/cz-ns-29-odo-231-2002.web.html.gz"),
    print: await fixture(
      "../parsers/__fixtures__/cz-ns-29-odo-231-2002.print.html.gz",
    ),
    docket: await fixture("__fixtures__/cz-ns-docket-29-odo-231-2002.html.gz"),
  });
  type Pages = Awaited<ReturnType<typeof pages>>;

  /** The recorded publisher: the docket search, the detail and the print page. */
  const servePublisher = async (): Promise<Pages> => {
    const served = await pages();
    testFetchState.set(
      asFetchMock(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes("WebSearch1")) {
          return await Promise.resolve(new Response(served.docket));
        }
        return await Promise.resolve(
          new Response(url.includes("/WebPrint/") ? served.print : served.web),
        );
      }),
    );
    return served;
  };

  const recapture = czNsAdapter.reconciliation.recapture;

  /** The decision a crawl of the listed row stores. */
  const crawled = async (): Promise<IngestionResult> => {
    const built = await buildCzNsDecision(LISTED_ROW);
    if (built.type !== "built") {
      throw new TypeError("Expected the recorded pages to build a decision");
    }
    return built.decision;
  };

  /** A row stored the old way: both pages, under the old media type. */
  const legacyRow = (
    decision: IngestionResult,
    served: Pages,
    overrides: Partial<StoredRawReparseInput>,
  ): StoredRawReparseInput => ({
    raw: new TextEncoder().encode(
      JSON.stringify({ webHtml: served.web, printHtml: served.print }),
    ),
    contentType: "text/html",
    caseNumber: decision.caseNumber,
    sourceDocumentId: decision.sourceDocumentId ?? null,
    language: decision.language,
    court: decision.court,
    ecli: decision.ecli ?? null,
    decisionDate: decision.decisionDate ?? null,
    decisionType: decision.decisionType ?? null,
    sourceUrl: decision.sourceUrl ?? null,
    documentUrl: decision.documentUrl ?? null,
    metadata: {},
    ...overrides,
  });

  test("the docket search lists the decision's own row", async () => {
    await servePublisher();

    const listed = await recapture.listLookup({ slice: DOCKET, page: 0 });

    expect(listed.items.map(({ payload }) => payload)).toEqual([LISTED_ROW]);
  });

  for (const [name, overrides] of [
    ["stored without its universal id", { sourceDocumentId: null }],
    [
      "stored with a malformed docket list",
      { metadata: { additionalCaseNumbers: DOCKET } },
    ],
  ] as const) {
    test(`a row ${name} replays to the crawled decision once recaptured`, async () => {
      const served = await servePublisher();
      const decision = await crawled();
      const stored = legacyRow(decision, served, overrides);

      expect(await czNsAdapter.reparseStoredRaw?.(stored)).toMatchObject({
        type: "rejected",
        rejection: "incomplete-metadata",
      });
      const outcome = await recaptureDecisionFromListing({
        adapter: czNsAdapter,
        stored,
      });

      expect(outcome).toMatchObject({ type: "recaptured", lookup: DOCKET });
      expect(outcome.type === "recaptured" ? outcome.result : null).toEqual(
        decision,
      );
    });
  }

  test("a row holding another universal id is not the listed one", async () => {
    const served = await servePublisher();
    const decision = await crawled();

    expect(
      await recaptureDecisionFromListing({
        adapter: czNsAdapter,
        stored: legacyRow(decision, served, {
          sourceDocumentId: "0123456789abcdef0123456789abcdef",
        }),
      }),
    ).toEqual({ type: "not-listed", lookup: DOCKET });
  });

  test("a row without its id column is still the document its URLs name", async () => {
    const served = await servePublisher();
    const decision = await crawled();
    const other = "0123456789abcdef0123456789abcdef";
    const urlOf = (url: string | undefined) =>
      (url ?? "").replace(LISTED_ROW.unid, () => other);
    const elsewhere = legacyRow(decision, served, {
      sourceDocumentId: null,
      sourceUrl: urlOf(decision.sourceUrl),
      documentUrl: urlOf(decision.documentUrl),
    });
    expect(elsewhere.sourceUrl).toContain(other);

    // The docket matches, but the row's URLs name another document.
    expect(
      await recaptureDecisionFromListing({
        adapter: czNsAdapter,
        stored: elsewhere,
      }),
    ).toEqual({ type: "not-listed", lookup: DOCKET });
    expect(
      recapture.recaptureStoredRaw({
        listingPayload: LISTED_ROW,
        stored: elsewhere,
      }),
    ).toMatchObject({ type: "identity-mismatch" });
    // A row whose column and URLs disagree names no single document.
    expect(
      recapture.recaptureStoredRaw({
        listingPayload: LISTED_ROW,
        stored: { ...elsewhere, sourceDocumentId: LISTED_ROW.unid },
      }),
    ).toMatchObject({ type: "identity-mismatch" });
  });

  test("a row spelling its id in another case is reported, not rebuilt", async () => {
    const served = await servePublisher();
    const decision = await crawled();

    expect(
      recapture.recaptureStoredRaw({
        listingPayload: LISTED_ROW,
        stored: legacyRow(decision, served, {
          sourceDocumentId: LISTED_ROW.unid.toLowerCase(),
        }),
      }),
    ).toMatchObject({
      type: "identity-mismatch",
      detail: expect.stringContaining("the same id in another case"),
    });
  });

  test("a row naming no id anywhere is found by its docket alone", async () => {
    const served = await servePublisher();
    const decision = await crawled();

    const outcome = await recaptureDecisionFromListing({
      adapter: czNsAdapter,
      stored: legacyRow(decision, served, {
        sourceDocumentId: null,
        sourceUrl: null,
        documentUrl: null,
      }),
    });

    expect(outcome).toMatchObject({ type: "recaptured", lookup: DOCKET });
  });

  test("a listing row stating another docket is reported, not merged", async () => {
    const served = await servePublisher();
    const decision = await crawled();

    expect(
      recapture.recaptureStoredRaw({
        listingPayload: { unid: LISTED_ROW.unid, caseNumber: "30 Cdo 1/2020" },
        stored: legacyRow(decision, served, { sourceDocumentId: null }),
      }),
    ).toMatchObject({ type: "identity-mismatch" });
  });

  test("an enveloped row replays from its own listing row, columns or not", async () => {
    await servePublisher();
    const decision = await crawled();

    const replayed = await czNsAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: decision.sourceRawContentType ?? null,
      caseNumber: decision.caseNumber,
      sourceDocumentId: null,
      language: decision.language,
      court: decision.court,
      ecli: decision.ecli ?? null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: {},
    });

    expect(replayed).toEqual({ type: "parsed", result: decision });
  });
});
