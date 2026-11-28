/**
 * cz-isir's walk over a feed page, its document reads, its stored payload and
 * its removal probe, through a stubbed transport.
 *
 * The transport and its documents are `tests/helpers/cz-isir-fixture.ts`'s;
 * every name and date in them is synthetic.
 */
import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@stll/case-law-ingestion-core/ingestion-types";
import type { IngestionResult } from "@stll/case-law-ingestion-core/ingestion-types";
import { CZ_ISIR_METADATA_KEY } from "@stll/legal-ast/cz-isir-decision";

import {
  czIsirAdapter,
  czIsirFetchPage,
  encodeCzIsirCursor,
  readCzIsirDocumentParagraphs,
} from "@/api/handlers/case-law/ingestion/adapters/cz-isir";
import { CZ_ISIR_FEED_URL } from "@/api/handlers/case-law/ingestion/adapters/cz-isir-feed";
import { probeCzIsirRemoval } from "@/api/handlers/case-law/ingestion/adapters/cz-isir-removal";
import {
  CZ_ISIR_FIXTURE_CURSOR,
  czIsirDecisionParagraphs,
  czIsirFixtureDocuments,
  type CzIsirServedDocuments,
  czIsirTransport,
  typesetCzIsirDocument,
} from "@/api/tests/helpers/cz-isir-fixture";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();
afterEach(() => {
  testFetchState.restore();
});

const serve = async (documents: CzIsirServedDocuments) => {
  const requested: string[] = [];
  testFetchState.set(await czIsirTransport(documents, requested));
  return requested;
};

const walk = async (documents: CzIsirServedDocuments) => {
  const requested = await serve(documents);
  const page = await czIsirFetchPage(CZ_ISIR_FIXTURE_CURSOR, {});
  if (Result.isError(page)) {
    throw page.error;
  }
  return { page: page.value, requested };
};

const documents = czIsirFixtureDocuments;

const byDocument = (decisions: readonly IngestionResult[], id: string) =>
  decisions.find(({ sourceDocumentId }) => sourceDocumentId === id);

const paragraphsSchema = v.array(
  v.strictObject({ text: v.string(), bold: v.boolean() }),
);

describe("czIsirFetchPage", () => {
  test("builds each high-court decision the page publishes", async () => {
    const { page } = await walk(await documents());
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["65350048", "81161847"]);
    const decision = byDocument(page.decisions, "65350048");
    expect(decision).toMatchObject({
      caseNumber: "3 VSPH 1361/2023",
      court: "Vrchní soud v Praze",
      country: "CZE",
      decisionDate: "2024-02-22",
      decisionType: "usnesení",
      sourceUrl:
        "https://isir.justice.cz:8443/isir_public_ws/doc/Document?idDokument=65350048",
    });
    expect(decision?.metadata[CZ_ISIR_METADATA_KEY]).toMatchObject({
      documentId: "65350048",
      actionId: 65_000_689,
      courtCode: "MSPHAAB",
      fileMark: "INS 10782/2023",
      section: "B",
      sectionNumber: 24,
      instance: "appellate",
      insolvencyFile: "MSPH 60 INS 10782/2023",
      filePosition: "B-24",
    });
    expect(byDocument(page.decisions, "81161847")).toMatchObject({
      caseNumber: "103 VSPH 257/2026",
      sheetNumber: "103",
      decisionType: "rozsudek",
      decisionDate: "2026-09-29",
    });
  });

  test("reads no side document, claim or decision of a proceeding the page strikes off", async () => {
    const { requested } = await walk(await documents());
    const documentReads = requested.filter((request) =>
      request.includes("idDokument="),
    );
    expect(documentReads).toEqual([
      "GET https://isir.justice.cz:8443/isir_public_ws/doc/Document?idDokument=65350048",
      "GET https://isir.justice.cz:8443/isir_public_ws/doc/Document?idDokument=81161847",
    ]);
    expect(requested.filter((request) => request.startsWith("POST"))).toEqual([
      `POST ${CZ_ISIR_FEED_URL}`,
    ]);
  });

  test("a 404 is no withdrawal: the document is unread and asked for again, the page keeps what it built", async () => {
    const { page } = await walk({ ...(await documents()), "65350048": null });
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["81161847"]);
    expect(page.unreadItems).toEqual([
      {
        listing: expect.objectContaining({
          sourceDocumentId: "65350048",
          isListingOnly: true,
          caseNumberIsPlaceholder: true,
        }),
        outcome: {
          type: "unavailable",
          cause: { kind: "status", status: 404 },
        },
      },
    ]);
  });

  test("a document the server cannot answer for is unread, and the page goes on", async () => {
    const { page } = await walk({ ...(await documents()), "65350048": 503 });
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["81161847"]);
    expect(page.unreadItems?.map(({ outcome }) => outcome.type)).toEqual([
      "unavailable",
    ]);
  });

  test("skips a document the register states gone", async () => {
    const { page } = await walk({ ...(await documents()), "65350048": 410 });
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["81161847"]);
    expect(page.unreadItems).toBeUndefined();
  });

  test("a document that reads but does not parse keeps its listing, without text", async () => {
    const { page } = await walk({
      ...(await documents()),
      "65350048": await typesetCzIsirDocument([
        { text: "Text bez záhlaví a data.", bold: false },
      ]),
    });
    const listing = byDocument(page.decisions, "65350048");
    expect(listing).toMatchObject({
      isListingOnly: true,
      caseNumberIsPlaceholder: true,
    });
    expect(listing?.fulltext ?? "").toBe("");
    expect(
      Object.keys(decodeSourceRawEnvelope(listing?.sourceRaw ?? "") ?? {}),
    ).toEqual(["action"]);
    expect(page.itemBuildFailures).toEqual({
      type: "item_build_failed",
      count: 1,
    });
  });

  test("moves the cursor to the page's last action, and stands still past the end", async () => {
    const { page } = await walk(await documents());
    expect(page.nextCursor).toBe(
      encodeCzIsirCursor({ version: 1, after: 81_530_365 }),
    );
  });

  test("stores the text and the action, never the document", async () => {
    const { page } = await walk(await documents());
    const decision = byDocument(page.decisions, "65350048");
    expect(decision?.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    const parts = decodeSourceRawEnvelope(decision?.sourceRaw ?? "");
    expect(Object.keys(parts ?? {}).toSorted()).toEqual(["action", "text"]);
    expect(decision?.sourceRaw).not.toContain("%PDF");
    const stored = v.parse(
      paragraphsSchema,
      JSON.parse(parts?.["text"] ?? "[]"),
    );
    expect(stored.map(({ text }) => text).join("\n")).toContain(
      "Proti tomuto usnesení není dovolání přípustné",
    );
  });

  test("a replay rebuilds the decision from the stored payload alone", async () => {
    const { page } = await walk(await documents());
    const decision = byDocument(page.decisions, "65350048");
    const replayed = await czIsirAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision?.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: "3 VSPH 1361/2023",
      sourceDocumentId: "65350048",
      language: "cs",
      court: "Vrchní soud v Praze",
      ecli: null,
      decisionDate: "2024-02-22",
      decisionType: "usnesení",
      sourceUrl: decision?.sourceUrl ?? null,
      documentUrl: decision?.documentUrl ?? null,
      metadata: {},
    });
    expect(replayed?.type).toBe("parsed");
    if (replayed?.type === "parsed") {
      expect(String(replayed.result.caseNumber)).toBe("3 VSPH 1361/2023");
      expect(String(replayed.result.fulltext)).toBe(String(decision?.fulltext));
    }
  });

  test("stores a decision's text as the register publishes it", async () => {
    // A synthetic party block: the register's documents name parties in full,
    // and the stored text keeps them as published.
    const party =
      "Jan Vzorový, narozený 1. 1. 1970, bytem Vzorová 1, 110 00 Praha 1";
    const paragraphs = await czIsirDecisionParagraphs("65350048");
    const { page } = await walk({
      ...(await documents()),
      "65350048": await typesetCzIsirDocument([
        ...paragraphs.slice(0, 3),
        { text: party, bold: false },
        ...paragraphs.slice(3),
      ]),
    });
    const decision = byDocument(page.decisions, "65350048");
    expect(decision?.isListingOnly).not.toBe(true);
    const parts = decodeSourceRawEnvelope(decision?.sourceRaw ?? "");
    const stored = v.parse(
      paragraphsSchema,
      JSON.parse(parts?.["text"] ?? "[]"),
    );
    expect(stored.map(({ text }) => text)).toContain(party);
    expect(String(decision?.fulltext)).toContain(party);
  });
});

describe("readCzIsirDocumentParagraphs", () => {
  test("drops the register's signature stamp", async () => {
    const paragraphs = await readCzIsirDocumentParagraphs(
      await typesetCzIsirDocument(await czIsirDecisionParagraphs("65350048")),
    );
    expect(Result.isOk(paragraphs)).toBe(true);
    if (Result.isOk(paragraphs)) {
      const text = paragraphs.value.map(({ text: line }) => line).join("\n");
      expect(text).not.toContain("cn=ISIR");
      expect(text).not.toContain("S131469");
      expect(paragraphs.value[0]?.text).toBe(
        "č. j. MSPH 60 INS 10782/2023 3 VSPH 1361/2023-B-24",
      );
    }
  });

  test("keeps a line that cites another file, and drops nothing of the text", async () => {
    const decision = await czIsirDecisionParagraphs("65350048");
    const cited = { text: "KSUL 74 INS 12709/2022", bold: false };
    const paragraphs = await readCzIsirDocumentParagraphs(
      await typesetCzIsirDocument([
        ...decision.slice(0, 4),
        cited,
        ...decision.slice(4),
      ]),
    );
    expect(
      Result.isOk(paragraphs) &&
        paragraphs.value.some(({ text }) => text === cited.text),
    ).toBe(true);
  });

  test("a PDF with nothing on its text layer is a scan", async () => {
    const pdf = PDF.create();
    pdf.addPage({ size: "a4" });
    expect(await readCzIsirDocumentParagraphs(await pdf.save())).toEqual(
      Result.err("no-text-layer"),
    );
  });
});

describe("reconciliation", () => {
  test("walks to the tip the feed answers, past the estimate, and stops there", async () => {
    const feed = await Bun.file(
      new URL("__fixtures__/cz-isir-feed-page.xml", import.meta.url),
    ).text();
    // The register has published past the estimated tip: the last page of
    // block 989 is answered with an action of block 990.
    testFetchState.set(
      await czIsirTransport(
        await documents(),
        [],
        feed.replace("<id>81530365</id>", "<id>99000005</id>"),
      ),
    );
    const { reconciliation } = czIsirAdapter;
    await reconciliation.listSlicePage({ slice: "00989", page: 99 });
    expect(reconciliation.nextSlice("00989")).toBe("00990");
    expect(reconciliation.nextSlice("00990")).toBeNull();
  });

  test("a stored action whose document id is not one is unkeyable, and nothing is requested", async () => {
    const requested = await serve(await documents());
    const outcome = await czIsirAdapter.reconciliation.buildDecision({
      id: 65_000_401,
      createdAt: null,
      publishedAt: null,
      documentId: "../65350048",
      documentReference: "document",
      fileMark: "INS 10782/2023",
      courtCode: "MSPHAAB",
      eventType: 373,
      eventDescription: null,
      section: "B",
      sectionNumber: 24,
      note: {
        sideDocument: false,
        sideEvent: false,
        fileState: null,
        finalOn: null,
        cancelledAt: null,
        correctedPublicationOn: null,
        struckOffOn: null,
      },
    });
    expect(outcome).toEqual({ type: "unkeyable" });
    expect(requested).toEqual([]);
  });
});

describe("probeCzIsirRemoval", () => {
  test("a document the register stops serving is absent; one it serves is present", async () => {
    const requested = await serve({ "65350048": new Uint8Array([1]) });
    const signal = new AbortController().signal;
    const present = await probeCzIsirRemoval("65350048", signal);
    const absent = await probeCzIsirRemoval("35296837", signal);
    expect(Result.isOk(present) && present.value.type).toBe("present");
    expect(Result.isOk(absent) && absent.value).toEqual({
      type: "absent",
      evidence: "http-404",
    });
    expect(requested.every((request) => request.startsWith("HEAD "))).toBe(
      true,
    );
  });

  test("an identity that is not a document id is never requested", async () => {
    const requested = await serve({});
    const probed = await probeCzIsirRemoval(
      "../x",
      new AbortController().signal,
    );
    expect(Result.isOk(probed) && probed.value.type).toBe("unprobeable");
    expect(requested).toEqual([]);
  });
});
