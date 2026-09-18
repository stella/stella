import { describe, expect, it } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import { readGzipJson } from "@/api/lib/gzip-json";
import { isRecord } from "@/api/lib/type-guards";

import {
  assembleAtRisDecision,
  AT_COURTS_SOURCE,
  atRisLastCompleteMonth,
  atRisMonthOf,
  atRisNextMonth,
  atRisPreviousMonth,
  createAtCourtsAdapter,
} from "./at-courts";
import { rejectionOf, requireReconciliation } from "./test-utils";

const SOURCE_ID = "JJT_20260115_OGH0002_0010OB00001_26A0000_000";
const SECOND_SOURCE_ID = "JJT_20260115_OGH0002_0010OB00001_26A0000_001";
const CASE_NUMBER = "1 Ob 1/26a";

const documentUrl = (id: string, extension: "html" | "xml") =>
  `https://ogd.ris.bka.gv.at/Dokumente/Justiz/${id}/${id}.${extension}`;

const listingItem = (
  id: string | null = SOURCE_ID,
  organ = "OGH",
): Record<string, unknown> => ({
  Data: {
    Metadaten: {
      Technisch: {
        ...(id === null ? {} : { ID: id }),
        Applikation: "Justiz",
        Organ: organ,
      },
      Allgemein: {
        Veroeffentlicht: "2026-01-20",
        Geaendert: "2026-01-21",
        DokumentUrl: `https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Justiz&Dokumentnummer=${id ?? "missing"}`,
      },
      Judikatur: {
        Dokumenttyp: "Text",
        Geschaeftszahl: { item: CASE_NUMBER },
        Normen: { item: ["ABGB §1295", "ZPO §502"] },
        Entscheidungsdatum: "2026-01-15",
        EuropeanCaseLawIdentifier:
          "ECLI:AT:OGH0002:2026:0010OB00001.26A.0115.000",
        Justiz: {
          Gericht: organ,
          Rechtsgebiete: { item: "Zivilrecht" },
          Rechtssatznummern: { item: "RS0135001" },
          Entscheidungstexte: {
            item: {
              Geschaeftszahl: CASE_NUMBER,
              Entscheidungsart: "Beschluss",
            },
          },
        },
      },
    },
    Dokumentliste: {
      ContentReference: {
        Urls: {
          ContentUrl: [
            ...(id === null
              ? []
              : [
                  { DataType: "Xml", Url: documentUrl(id, "xml") },
                  { DataType: "Html", Url: documentUrl(id, "html") },
                ]),
          ],
        },
      },
    },
  },
});

const HEADNOTE_ID = "JJR_20260115_OGH0002_0010OB00001_26A0000_001";

/** A headnote document of the same decision, as the publisher lists one. */
const headnoteItem = (): Record<string, unknown> => ({
  Data: {
    Metadaten: {
      Technisch: {
        ID: HEADNOTE_ID,
        Applikation: "Justiz",
        Organ: "OGH",
      },
      Allgemein: {
        DokumentUrl: `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Justiz&Dokumentnummer=${HEADNOTE_ID}`,
      },
      Judikatur: {
        Dokumenttyp: "Rechtssatz",
        Geschaeftszahl: { item: CASE_NUMBER },
        Entscheidungsdatum: "2026-01-15",
        EuropeanCaseLawIdentifier:
          "ECLI:AT:OGH0002:2026:0010OB00001.26A.0115.001",
        EntscheidungstextUrl: `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Justiz&Dokumentnummer=${SOURCE_ID}`,
      },
    },
    Dokumentliste: {
      ContentReference: {
        ContentType: "MainDocument",
        Urls: {
          ContentUrl: {
            DataType: "Xml",
            Url: `https://ogd.ris.bka.gv.at/Dokumente/Justiz/${HEADNOTE_ID}/${HEADNOTE_ID}.xml`,
          },
        },
      },
    },
  },
});

/** A nested element of a listing item, for a test that edits one. */
const nestedValue = (
  value: unknown,
  path: readonly string[],
): Record<string, unknown> => {
  let current = value;
  for (const key of path) {
    current = isRecord(current) ? current[key] : undefined;
  }
  if (!isRecord(current)) {
    throw new Error(`the listing fixture states no ${path.join("/")}`);
  }
  return current;
};

const contentUrlsOf = (
  item: Record<string, unknown>,
): Record<string, unknown>[] => {
  const urls = nestedValue(item, [
    "Data",
    "Dokumentliste",
    "ContentReference",
    "Urls",
  ])["ContentUrl"];
  if (!Array.isArray(urls)) {
    throw new TypeError("the listing fixture states no content URLs");
  }
  return urls.filter((entry) => isRecord(entry));
};

const listingResponse = (
  items: readonly Record<string, unknown>[],
  total = items.length,
  pageNumber = 1,
  pageSize = 100,
): Response =>
  Response.json({
    OgdSearchResult: {
      OgdDocumentResults: {
        Hits: {
          "@pageNumber": String(pageNumber),
          "@pageSize": String(pageSize),
          "#text": String(total),
        },
        ...(items.length === 0 ? {} : { OgdDocumentReference: items }),
      },
    },
  });

/** The publisher's answer to a headnote query that matches nothing. */
const emptyHeadnoteListing = (): Response => listingResponse([], 0);

const isHeadnoteQuery = (url: string): boolean =>
  new URL(url).searchParams.get("Dokumenttyp.SucheInRechtssaetzen") === "true";

/**
 * Answers the queue in order, except the headnote query every decision now
 * makes: a test that says nothing about headnotes gets the answer the
 * publisher gives for a decision with none, so the queue stays about the
 * request under test.
 */
const queuedRequest = (
  responses: readonly Response[],
  headnotes: () => Response = emptyHeadnoteListing,
) => {
  const queue = [...responses];
  const urls: string[] = [];
  const request = async (url: string): Promise<Response> => {
    urls.push(url);
    if (isHeadnoteQuery(url)) {
      return headnotes();
    }
    const response = queue.shift();
    if (response === undefined) {
      throw new TypeError(`Unexpected request: ${url}`);
    }
    return response;
  };
  return { request, urls };
};

/** The slice pages a run asked the publisher for, in order. */
const slicePageNumbers = (
  urls: readonly string[],
): readonly (string | null)[] =>
  urls
    .filter(
      (url) =>
        new URL(url).origin === "https://data.bka.gv.at" &&
        !isHeadnoteQuery(url),
    )
    .map((url) => new URL(url).searchParams.get("Seitennummer"));

/** The document requests a run made, in order, without the listing queries. */
const documentRequests = (urls: readonly string[]): readonly string[] =>
  urls.filter((url) => new URL(url).pathname.startsWith("/Dokumente/"));

const fixtureXml = async (): Promise<string> =>
  await Bun.file(
    new URL("../parsers/__fixtures__/at-ris-jjt-1925.xml", import.meta.url),
  ).text();

describe("Austrian RIS adapter", () => {
  it("declares the source and the publisher's crawl delay", () => {
    const adapter = createAtCourtsAdapter();
    expect(adapter.key).toBe("at-courts");
    expect(adapter.country).toBe("AUT");
    expect(adapter.language).toBe("de");
    expect(adapter.minRequestIntervalMs).toBe(5000);
    expect(adapter.pageTimeoutMs).toBe(25 * 60_000);
    expect(adapter.maxCycleMs).toBe(30 * 60_000);
    expect(adapter.maxSyncPages).toBe(1);
    const reconciliation = requireReconciliation(adapter);
    expect(reconciliation.firstSlice).toBe("1925-04");
    expect(reconciliation.tipWindowDays).toBe(3);
  });

  it("uses inverse, lexicographically ordered UTC month slices", () => {
    expect(atRisNextMonth("2025-12")).toBe("2026-01");
    expect(atRisPreviousMonth("2026-01")).toBe("2025-12");
    expect(atRisPreviousMonth("1925-04")).toBeNull();
    expect(atRisNextMonth("not-a-month")).toBeNull();
    expect(atRisMonthOf(new Date("2024-02-29T23:30:00Z"))).toBe("2024-02");
    expect(atRisLastCompleteMonth(new Date("2024-03-01T00:00:00Z"))).toBe(
      "2024-02",
    );
    const december = atRisPreviousMonth("2026-01");
    expect(december !== null && december < "2026-01").toBe(true);
  });

  it("maps the listed RIS ID through crawl, detail, AST, and raw storage", async () => {
    const xml = await fixtureXml();
    const firstListing = listingResponse([listingItem()]);
    const verificationListing = listingResponse([listingItem()]);
    const { request, urls } = queuedRequest([
      firstListing,
      new Response(xml, { status: 200 }),
      verificationListing,
    ]);
    const delays: number[] = [];
    const adapter = createAtCourtsAdapter({
      now: () => new Date("2026-02-01T00:00:00Z"),
      request,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    const collected = await adapter.fetchPage(null, {});
    expect(collected.isOk()).toBe(true);
    const firstPage = collected.unwrap();
    expect(firstPage.decisions).toHaveLength(1);
    const decision = firstPage.decisions[0];
    expect(decision?.sourceDocumentId).toBe(SOURCE_ID);
    expect(decision?.caseNumber).toBe(CASE_NUMBER);
    expect(decision?.ecli).toMatch(/^ECLI:AT:OGH0002:/u);
    expect(decision?.decisionDate).toBe("2026-01-15");
    expect(decision?.decisionType).toBe("beschluss");
    expect(decision?.documentAst).not.toEqual({});
    expect(
      Object.keys(decodeSourceRawEnvelope(decision?.sourceRaw ?? "") ?? {}),
    ).toEqual(["listing", "document-xml", "headnote-listing"]);
    expect(decision?.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(delays).toEqual([]);
    expect(new URL(urls[0] ?? "").searchParams.get("Applikation")).toBe(
      "Justiz",
    );
    expect(
      new URL(urls[0] ?? "").searchParams.get(
        "Dokumenttyp.SucheInEntscheidungstexten",
      ),
    ).toBe("true");
    expect(documentRequests(urls)).toEqual([documentUrl(SOURCE_ID, "xml")]);
    // Provenance cites the listing this page was read from, not the
    // per-decision document fetch that followed it.
    expect(firstPage.sourceUrl).toBe(urls[0]);

    const verified = await adapter.fetchPage(firstPage.nextCursor, {});
    expect(verified.isOk()).toBe(true);
    expect(verified.unwrap().decisions).toEqual([]);
  });

  it("keeps distinct publisher documents that share a docket", async () => {
    const xml = await fixtureXml();
    const { request } = queuedRequest([
      listingResponse([listingItem(), listingItem(SECOND_SOURCE_ID)]),
      new Response(xml),
      new Response(xml),
    ]);
    const adapter = createAtCourtsAdapter({
      request,
      sleep: async () => {},
    });

    const result = await adapter.fetchPage(null, {});
    expect(result.isOk()).toBe(true);
    expect(
      result.unwrap().decisions.map((decision) => decision.sourceDocumentId),
    ).toEqual([SOURCE_ID, SECOND_SOURCE_ID]);
    expect(
      new Set(result.unwrap().decisions.map((decision) => decision.caseNumber)),
    ).toEqual(new Set([CASE_NUMBER]));
  });

  it("validates publisher pagination across collection and verification", async () => {
    const xml = await fixtureXml();
    const foreignItems = Array.from({ length: 100 }, (_, index) =>
      listingItem(
        `JJT_20260115_AUSL0001_0010AB${String(index).padStart(5, "0")}_26A0000_000`,
        "AUSL EKMR",
      ),
    );
    const { request, urls } = queuedRequest([
      listingResponse(foreignItems, 101, 1),
      listingResponse([listingItem()], 101, 2),
      new Response(xml),
      listingResponse(foreignItems, 101, 1),
      listingResponse([listingItem()], 101, 2),
    ]);
    const adapter = createAtCourtsAdapter({
      now: () => new Date("2026-02-01T00:00:00Z"),
      request,
      sleep: async () => {},
    });

    const first = (await adapter.fetchPage(null, {})).unwrap();
    expect(first.decisions).toEqual([]);
    const second = (await adapter.fetchPage(first.nextCursor, {})).unwrap();
    expect(second.decisions).toHaveLength(1);
    const verifyFirst = (
      await adapter.fetchPage(second.nextCursor, {})
    ).unwrap();
    const verified = (
      await adapter.fetchPage(verifyFirst.nextCursor, {})
    ).unwrap();

    expect(verified.decisions).toEqual([]);
    expect(slicePageNumbers(urls)).toEqual(["1", "2", "1", "2"]);
  });

  it("restarts a stable slice whose pages contain fewer items than its total", async () => {
    const xml = await fixtureXml();
    const foreignItem = listingItem(undefined, "AUSL EKMR");
    const { request, urls } = queuedRequest([
      listingResponse([foreignItem], 101, 1),
      listingResponse([foreignItem], 101, 2),
      listingResponse([listingItem()], 101, 1),
      new Response(xml),
    ]);
    const adapter = createAtCourtsAdapter({
      now: () => new Date("2026-02-01T00:00:00Z"),
      request,
      sleep: async () => {},
    });

    const first = (await adapter.fetchPage(null, {})).unwrap();
    const second = (await adapter.fetchPage(first.nextCursor, {})).unwrap();
    const restarted = (await adapter.fetchPage(second.nextCursor, {})).unwrap();

    expect(restarted.decisions).toHaveLength(1);
    expect(slicePageNumbers(urls)).toEqual(["1", "2", "1"]);
  });

  it("rejects a listing body for a different publisher page", async () => {
    const { request } = queuedRequest([
      listingResponse([listingItem()], 101, 2),
    ]);
    const adapter = createAtCourtsAdapter({
      request,
      sleep: async () => {},
    });

    expect((await adapter.fetchPage(null, {})).isErr()).toBe(true);
  });

  it("refuses a monthly set beyond the reconciliation page cap", async () => {
    const adapter = createAtCourtsAdapter({
      now: () => new Date("2026-02-01T00:00:00Z"),
      request: async () => listingResponse([listingItem()], 20_001),
      sleep: async () => {},
    });

    expect((await adapter.fetchPage(null, {})).isErr()).toBe(true);
    const reconciliation = requireReconciliation(adapter);
    const rejection = await rejectionOf(
      reconciliation.listSlicePage({ slice: "2026-01", page: 0 }),
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      message: expect.stringContaining("exceeds 200 pages"),
    });
  });

  it("quarantines an identity-less row without blocking later documents", async () => {
    const xml = await fixtureXml();
    const unkeyable = listingItem(null);
    const { request } = queuedRequest([
      listingResponse([unkeyable, listingItem()]),
      new Response(xml),
    ]);
    const adapter = createAtCourtsAdapter({
      request,
      sleep: async () => {},
    });

    const page = (await adapter.fetchPage(null, {})).unwrap();
    expect(page.decisions).toHaveLength(2);
    expect(page.decisions[0]?.sourceDocumentId).toMatch(
      /^ris-quarantine:[a-f0-9]+$/u,
    );
    expect(page.decisions[0]?.metadata["detailStatus"]).toBe(
      "publisher-id-unavailable",
    );
    expect(page.decisions[1]?.sourceDocumentId).toBe(SOURCE_ID);
    expect(page.decisions[1]?.sourceDocumentIdRepairAliases).toContain(
      page.decisions[0]?.sourceDocumentId,
    );
  });

  it("stores a listing-only row for a permanently missing detail", async () => {
    const { request } = queuedRequest([
      listingResponse([listingItem()]),
      new Response(null, { status: 404 }),
    ]);
    const adapter = createAtCourtsAdapter({
      request,
      sleep: async () => {},
    });

    const result = await adapter.fetchPage(null, {});
    expect(result.isOk()).toBe(true);
    const decision = result.unwrap().decisions[0];
    expect(decision?.sourceDocumentId).toBe(SOURCE_ID);
    expect(decision?.isListingOnly).toBe(true);
    expect(decision?.fulltext).toBeUndefined();
    expect(decision?.metadata["detailStatus"]).toBe("detail-http-404");
  });

  it("throws on transient or unparseable listings and accepts an explicit zero", async () => {
    const transient = createAtCourtsAdapter({
      request: async () => new Response(null, { status: 503 }),
      sleep: async () => {},
    });
    expect((await transient.fetchPage(null, {})).isErr()).toBe(true);

    const malformed = createAtCourtsAdapter({
      request: async () => Response.json({ status: "ok" }),
      sleep: async () => {},
    });
    expect((await malformed.fetchPage(null, {})).isErr()).toBe(true);

    const empty = createAtCourtsAdapter({
      request: async () => listingResponse([], 0),
      sleep: async () => {},
      now: () => new Date("2026-03-01T00:00:00Z"),
    });
    const emptyResult = await empty.fetchPage(null, {});
    expect(emptyResult.isOk()).toBe(true);
    expect(emptyResult.unwrap().decisions).toEqual([]);
    expect(emptyResult.unwrap().nextCursor).not.toBeNull();
  });

  it("subtracts the publisher's foreign-court subset from its total", async () => {
    const { request, urls } = queuedRequest([
      listingResponse([listingItem()], 172_213),
      listingResponse([listingItem(SOURCE_ID, "AUSL EKMR")], 2200),
    ]);
    const delays: number[] = [];
    const adapter = createAtCourtsAdapter({
      request,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    const count = await adapter.getTotalCount(new AbortController().signal);
    expect(count).toEqual({ type: "count", total: 170_013 });
    expect(delays).toEqual([5000]);
    expect(new URL(urls[1] ?? "").searchParams.get("Gericht")).toBe("AUSL");
  });

  it("rejects cursors outside the monthly snapshot state machine", async () => {
    const adapter = createAtCourtsAdapter({
      request: async () => {
        throw new Error("should not fetch");
      },
      sleep: async () => {},
    });
    expect((await adapter.fetchPage("abc", {})).isErr()).toBe(true);
    expect((await adapter.fetchPage("0", {})).isErr()).toBe(true);
  });

  it("lists reconciliation pages with the crawl's exact identity rule", async () => {
    const unkeyable = listingItem(null);
    const foreign = listingItem(SECOND_SOURCE_ID, "AUSL EKMR");
    const { request, urls } = queuedRequest([
      listingResponse([listingItem(), unkeyable, foreign], 3),
    ]);
    const delays: number[] = [];
    const adapter = createAtCourtsAdapter({
      now: () => new Date("2026-02-01T00:00:00Z"),
      request,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    const reconciliation = requireReconciliation(adapter);

    const listed = await reconciliation.listSlicePage({
      slice: "2026-01",
      page: 0,
    });

    expect(listed.totalPages).toBe(1);
    expect(listed.items).toHaveLength(2);
    expect(listed.items[0]?.identity).toEqual({
      type: "document",
      sourceDocumentId: SOURCE_ID,
    });
    expect(listed.items[1]?.identity).toEqual({
      type: "document",
      sourceDocumentId: expect.stringMatching(/^ris-quarantine:[a-f0-9]+$/u),
    });
    expect(delays).toEqual([5000]);
    expect(new URL(urls[0] ?? "").searchParams.get("Seitennummer")).toBe("1");
    expect(
      new URL(urls[0] ?? "").searchParams.get("EntscheidungsdatumVon"),
    ).toBe("2026-01-01");
  });

  it("builds reconciliation detail but never stores a hollow listing", async () => {
    const xml = await fixtureXml();
    const { request } = queuedRequest([
      new Response(xml),
      new Response(null, { status: 404 }),
    ]);
    const adapter = createAtCourtsAdapter({
      request,
      sleep: async () => {},
    });
    const reconciliation = requireReconciliation(adapter);

    const built = await reconciliation.buildDecision(listingItem());
    expect(built.type).toBe("built");
    if (built.type === "built") {
      expect(built.decision.sourceDocumentId).toBe(SOURCE_ID);
      expect(built.decision.isListingOnly).not.toBe(true);
    }
    expect(
      await reconciliation.buildDecision(listingItem(SECOND_SOURCE_ID)),
    ).toEqual({ type: "detail-unavailable" });
    expect(await reconciliation.buildDecision(listingItem(null))).toEqual({
      type: "detail-unavailable",
    });
    expect(await reconciliation.buildDecision({ status: "stale" })).toEqual({
      type: "unkeyable",
    });
  });

  it("walks reconciliation months within the immutable tip", () => {
    const adapter = createAtCourtsAdapter({
      now: () => new Date("2026-02-15T12:00:00Z"),
    });
    const reconciliation = requireReconciliation(adapter);

    expect(reconciliation.sliceOf(new Date("2026-02-15T12:00:00Z"))).toBe(
      "2026-01",
    );
    expect(reconciliation.nextSlice("2025-12")).toBe("2026-01");
    expect(reconciliation.nextSlice("2026-01")).toBeNull();
    expect(reconciliation.previousSlice("2026-01")).toBe("2025-12");
    expect(reconciliation.previousSlice(reconciliation.firstSlice)).toBeNull();
  });

  it("follows the document address the listing states, at either host", async () => {
    const xml = await fixtureXml();
    for (const origin of [
      "https://ogd.ris.bka.gv.at",
      "https://www.ris.bka.gv.at",
    ]) {
      const listed = `${origin}/Dokumente/Justiz/${SOURCE_ID}/${SOURCE_ID}.xml`;
      const item = listingItem();
      const urls = contentUrlsOf(item);
      const xmlEntry = urls.find((entry) => entry["DataType"] === "Xml");
      if (xmlEntry === undefined) {
        throw new TypeError("the listing fixture states no XML address");
      }
      xmlEntry["Url"] = listed;
      const { request, urls: requested } = queuedRequest([
        listingResponse([item]),
        new Response(xml),
      ]);
      const adapter = createAtCourtsAdapter({ request, sleep: async () => {} });

      const decision = (await adapter.fetchPage(null, {})).unwrap()
        .decisions[0];

      expect(decision?.isListingOnly).not.toBe(true);
      expect(documentRequests(requested)).toEqual([listed]);
    }
  });

  it("reads a decision whose document embeds images", async () => {
    const xml = await fixtureXml();
    const item = listingItem();
    const documentList = nestedValue(item, ["Data", "Dokumentliste"]);
    const reference = documentList["ContentReference"];
    // The publisher lists such a decision as several references rather than
    // one, which is the shape that made every one of them listing-only.
    documentList["ContentReference"] = [
      reference,
      {
        ContentType: "EmbeddedAttachment",
        Name: "Anlage 1",
        Urls: {
          ContentUrl: {
            DataType: "Png",
            Url: `https://ogd.ris.bka.gv.at/Dokumente/Justiz/${SOURCE_ID}/${SOURCE_ID}.1.png`,
          },
        },
      },
    ];
    const { request } = queuedRequest([
      listingResponse([item]),
      new Response(xml),
    ]);
    const adapter = createAtCourtsAdapter({ request, sleep: async () => {} });

    const decision = (await adapter.fetchPage(null, {})).unwrap().decisions[0];

    expect(decision?.isListingOnly).not.toBe(true);
    expect(decision?.metadata["documentParts"]).toHaveLength(2);
    expect(decision?.metadata["contentFormats"]).toContain("Xml");
  });

  it("stores the headnotes the publisher indexes under the decision", async () => {
    const xml = await fixtureXml();
    const { request, urls } = queuedRequest(
      [listingResponse([listingItem()]), new Response(xml)],
      () => listingResponse([headnoteItem()]),
    );
    const adapter = createAtCourtsAdapter({ request, sleep: async () => {} });

    const decision = (await adapter.fetchPage(null, {})).unwrap().decisions[0];

    const headnoteQuery = urls.find((url) => isHeadnoteQuery(url));
    expect(
      new URL(headnoteQuery ?? "").searchParams.get("Geschaeftszahl"),
    ).toBe(CASE_NUMBER);
    expect(decision?.metadata["headnotes"]).toEqual([
      {
        sourceDocumentId: HEADNOTE_ID,
        caseNumbers: [CASE_NUMBER],
        ecli: "ECLI:AT:OGH0002:2026:0010OB00001.26A.0115.001",
        documentUrl: `https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Justiz&Dokumentnummer=${HEADNOTE_ID}`,
      },
    ]);
    expect(
      decodeSourceRawEnvelope(decision?.sourceRaw ?? "")?.["headnote-listing"],
    ).toContain(HEADNOTE_ID);
  });

  it("rebuilds every recorded page row that the host move left listing-only", async () => {
    const xml = await fixtureXml();
    const recording: unknown = await readGzipJson(
      new URL("__fixtures__/at-courts-page.json.gz", import.meta.url),
    );
    const page = isRecord(recording) ? recording["page"] : undefined;
    const decisions = isRecord(page) ? page["decisions"] : undefined;
    if (!Array.isArray(decisions)) {
      throw new TypeError("the recorded page holds no decisions");
    }

    const listingItems = decisions.map((decision) => {
      const raw: unknown = JSON.parse(
        isRecord(decision) && typeof decision["sourceRaw"] === "string"
          ? decision["sourceRaw"]
          : "null",
      );
      const listed = isRecord(raw) ? raw["listing"] : undefined;
      if (!isRecord(listed)) {
        throw new Error("a recorded row holds no listing payload");
      }
      return listed;
    });
    const recordedListingOnly = decisions.filter(
      (decision) => isRecord(decision) && decision["isListingOnly"] === true,
    ).length;

    const rebuilt = listingItems.map((item) =>
      assembleAtRisDecision(AT_COURTS_SOURCE, item, { documentXml: xml }),
    );

    // The recording is of the defect: the publisher moved its documents to
    // another of its hosts, the crawl kept rebuilding the old address, and
    // every row it wrote that day carried a listing and no decision.
    expect(recordedListingOnly).toBe(decisions.length);
    expect(
      rebuilt.filter((decision) => decision.isListingOnly === true),
    ).toEqual([]);
  });
});
