import { describe, expect, test } from "bun:test";

import { ADAPTER_KEYS, PARSER_VERSIONS } from "@/api/handlers/case-law/consts";
import {
  EMPTY_AST,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  encodeSourceRawEnvelope,
  decodeSourceRawEnvelope,
} from "@/api/handlers/case-law/ingestion/adapter";
import { buildPlainTextItem } from "@/api/handlers/case-law/ingestion/adapters/item-build";
import { plainTextIngestionResult } from "@/api/handlers/case-law/ingestion/adapters/plain-text-assembly";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";

const sourceDecision = (caseNumber: string, sourceDocumentId?: string) =>
  plainTextIngestionResult({
    caseNumber,
    sourceDocumentId,
    court: "Source court",
    country: "CZE",
    language: "cs",
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: {},
    documentAst: EMPTY_AST,
    rawHash: "fixture-hash",
  });

describe("plain-text item rejection", () => {
  test("quarantines a poison item while retaining its healthy siblings", async () => {
    const rawListing = '<record id="rejected">\\rtf1 malformed text</record>';
    const items = await Promise.all(
      ["healthy", "\\rtf1 malformed text", "later"].map(
        async (label, index) =>
          await buildPlainTextItem({
            adapterKey: ADAPTER_KEYS.CZ_NSS,

            rawListing,
            build: async () => sourceDecision(label, String(index)),
            decisionOf: (value) => value,
          }),
      ),
    );
    expect(items.map((item) => item.type)).toEqual([
      "built",
      "item_build_failed",
      "built",
    ]);
    const rejected = items.at(1);
    expect(rejected?.type).toBe("item_build_failed");
    if (rejected?.type !== "item_build_failed") {
      throw new Error("Expected item rejection");
    }
    expect(rejected.decision.sourceDocumentId).toBe("1");
    expect(rejected.decision.caseNumberIsPlaceholder).toBe(true);
    expect(rejected.decision.isListingOnly).toBe(true);
    expect(rejected.decision.fulltext).toBeUndefined();
    expect(rejected.decision.metadata.plainTextFailureReason).toBe(
      "rtf-syntax",
    );
    expect(rejected.decision.metadata.detailStatus).toBe("item_build_failed");
    expect(rejected.decision.parserVersion).toBe(
      PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS],
    );
    expect(
      decodeSourceRawEnvelope(rejected.decision.sourceRaw ?? "")?.listing,
    ).toBe(rawListing);
  });

  test("a rejected item without a usable publisher identity has a stable raw quarantine", async () => {
    for (const sourceDocumentId of [
      undefined,
      "x".repeat(1000),
      "\\rtf1",
      "id\u0000",
      "id\u200b",
    ]) {
      const options = {
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        rawListing: '{"label":"\\\\rtf1"}',
        build: async () => sourceDecision("\\rtf1", sourceDocumentId),
        decisionOf: (value: ReturnType<typeof sourceDecision>) => value,
      };
      const first = await buildPlainTextItem(options);
      const replay = await buildPlainTextItem(options);
      expect(first).toEqual(replay);
      expect(first.type).toBe("item_build_failed");
      if (first.type !== "item_build_failed") {
        throw new Error("Expected item rejection");
      }
      expect(first.decision.sourceRaw).toBeDefined();
      expect(first.decision.sourceDocumentId).toBeDefined();
      expect(sanitizeResult(first.decision).sourceDocumentId).toBe(
        first.decision.sourceDocumentId,
      );
      expect(first.decision.caseNumber).not.toContain("\\rtf1");
    }
  });

  test("typed rejection preserves every fetched raw envelope part and binary payload", async () => {
    const sourceRaw = encodeSourceRawEnvelope({
      listing: "original listing",
      detail: "detail page",
      document: "document text",
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const built = plainTextIngestionResult({
      ...sourceDecision("valid", "123"),
      caseNumber: "\\rtf1 rejected",
      sourceRaw,
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      sourceRawObjects: { document: { bytes, contentType: "application/pdf" } },
    });
    const item = await buildPlainTextItem({
      adapterKey: ADAPTER_KEYS.CZ_NSS,

      rawListing: "fallback listing",
      build: async () => built,
      decisionOf: (value) => value,
    });
    expect(item.type).toBe("item_build_failed");
    if (item.type !== "item_build_failed") {
      throw new Error("Expected item rejection");
    }
    expect(item.decision.sourceRaw).toBe(sourceRaw);
    expect(item.decision.sourceRawObjects?.document?.bytes).toBe(bytes);
    expect(
      Object.keys(decodeSourceRawEnvelope(item.decision.sourceRaw ?? "") ?? {}),
    ).toEqual(["listing", "detail", "document"]);
  });

  test("caller cancellation and publisher faults remain page failures", async () => {
    const errors = [
      new DOMException("Cancelled", "AbortError"),
      new AdapterFetchError({
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        cursor: "page",
        message: "Publisher unavailable",
      }),
    ];
    for (const error of errors) {
      await expect(
        buildPlainTextItem({
          adapterKey: ADAPTER_KEYS.CZ_NSS,

          rawListing: "{}",
          build: async () => await Promise.reject(error),
          decisionOf: () => undefined,
        }),
      ).rejects.toBe(error);
    }
  });
});
