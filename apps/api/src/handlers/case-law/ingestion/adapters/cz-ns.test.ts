import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  buildCzNsDecision,
  czNsAdapter,
  type CzNsListingRow,
} from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { PublisherPageError } from "@/api/handlers/case-law/ingestion/adapters/publisher-page";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { isReadRefusal } from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
  decodeSourceRawEnvelope,
  type StoredRawReparseInput,
} from "@/api/lib/legal-search/ingestion-types";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

describe("Domino listings distinguish publisher refusal from an empty view", () => {
  afterEach(() => mock.restore());

  for (const body of [
    "<html><form><input type='password'></form></html>",
    "{}",
    '{"viewentry":[]}',
    '{"@toplevelentries":"1"}',
    '{"@toplevelentries":',
    "",
  ]) {
    test(`rejects an unreadable page ${JSON.stringify(body)}`, async () => {
      spyOn(globalThis, "fetch").mockImplementation(
        asFetchMock(async () => new Response(body)),
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
      spyOn(globalThis, "fetch").mockImplementation(
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
                          { "@name": "znacka", text: { "0": "1 Cdo 1/2026" } },
                        ],
                      },
                    ],
                  })
                : "<html><body><p>Rozhodnutí soudu.</p></body></html>",
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
    spyOn(globalThis, "fetch").mockImplementation(
      asFetchMock(async () => new Response('{"@toplevelentries":"0"}')),
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
  afterEach(() => mock.restore());

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
    spyOn(globalThis, "fetch").mockImplementation(
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
  afterEach(() => mock.restore());

  const UNID = "fedcba9876543210fedcba9876543210";
  const PAGE = "<html><body><p>Rozhodnutí soudu.</p></body></html>";

  const built = async (row: CzNsListingRow) => {
    spyOn(globalThis, "fetch").mockImplementation(
      asFetchMock(async () => await Promise.resolve(new Response(PAGE))),
    );
    const result = await buildCzNsDecision(row);
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
    spyOn(globalThis, "fetch").mockImplementation(
      asFetchMock(() => {
        throw new TypeError("Stored-raw replay must not contact the publisher");
      }),
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
