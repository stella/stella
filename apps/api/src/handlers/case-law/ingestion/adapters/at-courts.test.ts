import { describe, expect, it } from "bun:test";

import {
  atRisLastCompleteMonth,
  atRisMonthOf,
  atRisNextMonth,
  atRisPreviousMonth,
  createAtCourtsAdapter,
} from "./at-courts";
import { requireReconciliation } from "./test-utils";

const SOURCE_ID = "JJT_20260115_OGH0002_0010OB00001_26A0000_000";
const SECOND_SOURCE_ID = "JJT_20260115_OGH0002_0010OB00001_26A0000_001";
const CASE_NUMBER = "1 Ob 1/26a";

const documentUrl = (id: string, extension: "html" | "xml") =>
  `https://www.ris.bka.gv.at/Dokumente/Justiz/${id}/${id}.${extension}`;

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

const queuedRequest = (responses: readonly Response[]) => {
  const queue = [...responses];
  const urls: string[] = [];
  const request = async (url: string): Promise<Response> => {
    urls.push(url);
    const response = queue.shift();
    if (response === undefined) {
      throw new Error(`Unexpected request: ${url}`);
    }
    return response;
  };
  return { request, urls };
};

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
    expect(decision?.sourceRaw).toContain('"documentXml"');
    expect(decision?.sourceRawContentType).toBe("application/json");
    expect(delays).toEqual([]);
    expect(new URL(urls[0] ?? "").searchParams.get("Applikation")).toBe(
      "Justiz",
    );
    expect(
      new URL(urls[0] ?? "").searchParams.get(
        "Dokumenttyp.SucheInEntscheidungstexten",
      ),
    ).toBe("true");
    expect(urls[1]).toBe(documentUrl(SOURCE_ID, "xml"));

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
    expect(
      urls
        .filter((url) => new URL(url).origin === "https://data.bka.gv.at")
        .map((url) => new URL(url).searchParams.get("Seitennummer")),
    ).toEqual(["1", "2", "1", "2"]);
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
    expect(
      urls
        .filter((url) => new URL(url).origin === "https://data.bka.gv.at")
        .map((url) => new URL(url).searchParams.get("Seitennummer")),
    ).toEqual(["1", "2", "1"]);
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
    await expect(
      reconciliation.listSlicePage({ slice: "2026-01", page: 0 }),
    ).rejects.toThrow("exceeds 200 pages");
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
});
