/**
 * cz-isir's walk over a feed page, its document reads, its stored payload and
 * its removal probe, through a stubbed transport.
 *
 * The transport and its documents are `tests/helpers/cz-isir-fixture.ts`'s.
 * Anonymisation itself is covered by `cz-isir-anonymization.test.ts`; the walk
 * here runs with a pass-through anonymiser over text that holds no personal
 * data, so what it asserts is the reading and the storing.
 */
import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  czIsirAdapter,
  czIsirFetchPage,
  encodeCzIsirCursor,
  readCzIsirDocumentParagraphs,
} from "@/api/handlers/case-law/ingestion/adapters/cz-isir";
import {
  CZ_ISIR_ANONYMIZATION_FAILURE,
  CzIsirAnonymizationError,
  type CzIsirAnonymizer,
} from "@/api/handlers/case-law/ingestion/adapters/cz-isir-anonymization";
import { CZ_ISIR_FEED_URL } from "@/api/handlers/case-law/ingestion/adapters/cz-isir-feed";
import { probeCzIsirRemoval } from "@/api/handlers/case-law/ingestion/adapters/cz-isir-removal";
import { CZ_ISIR_METADATA_KEY } from "@/api/lib/legal-search/cz-isir-decision";
import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import {
  CZ_ISIR_FIXTURE_CURSOR,
  CZ_ISIR_PASS_THROUGH,
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
  const page = await czIsirFetchPage(
    CZ_ISIR_FIXTURE_CURSOR,
    {},
    undefined,
    CZ_ISIR_PASS_THROUGH,
  );
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

  test("skips a document the register no longer serves", async () => {
    const { page } = await walk({ ...(await documents()), "65350048": null });
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["81161847"]);
  });

  test("moves the cursor to the page's last action, and stands still past the end", async () => {
    const { page } = await walk(await documents());
    expect(page.nextCursor).toBe(
      encodeCzIsirCursor({ version: 1, after: 81_530_365 }),
    );
  });

  test("stores the anonymised text and the action, never the document", async () => {
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

  test("stores nothing of a document that cannot be anonymised", async () => {
    await serve(await documents());
    const refusing: CzIsirAnonymizer = {
      anonymize: () =>
        Result.err(
          new CzIsirAnonymizationError({
            reason: CZ_ISIR_ANONYMIZATION_FAILURE.NAME_LEFT,
            message: "refused",
          }),
        ),
    };
    const page = await czIsirFetchPage(
      encodeCzIsirCursor({ version: 1, after: 65_000_400 }),
      {},
      undefined,
      refusing,
    );
    expect(Result.isOk(page) && page.value.decisions).toEqual([]);
    expect(Result.isOk(page) && page.value.itemBuildFailures).toEqual({
      type: "item_build_failed",
      count: 2,
    });
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
  test("a stored action whose document id is not one is unkeyable, and nothing is requested", async () => {
    const requested = await serve(await documents());
    const outcome = await czIsirAdapter.reconciliation.buildDecision({
      id: 65_000_401,
      createdAt: null,
      publishedAt: null,
      documentId: "../65350048",
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
