import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { createSafeId } from "@/api/lib/branded-types";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  STORED_RAW_REPARSE_REJECTION,
  STORED_RAW_REPLAY_STATUS,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  IngestionResult,
  StoredRawReparseInput,
} from "@/api/lib/legal-search/ingestion-types";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { parsePendingDocument } from "@/api/lib/legal-search/sk-document-backfill";
import { captureSkDocumentRaw } from "@/api/lib/legal-search/sk-document-raw";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { skCourtsFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { memorySkDocumentRawStorage } from "@/api/tests/helpers/sk-document-raw-storage";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetchState = createTestFetch();
const replay =
  skCourtsAdapter.reparseStoredRaw ?? panic("SK courts replay required");

const storedInput = (decision: IngestionResult, raw: string) =>
  ({
    raw: new TextEncoder().encode(raw),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
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
  }) as const satisfies StoredRawReparseInput;

const rejectPublisherReads = () => {
  testFetchState.set(
    asFetchMock(async () =>
      panic("Stored replay cannot fetch publisher responses"),
    ),
  );
};

describe("SK courts stored document replay", () => {
  test("stored document objects match the backfill entry point and form a fixed point", async () => {
    const decision = await skCourtsFixture().buildDecision();
    const pdf = PDF.create();
    pdf
      .addPage({ size: "letter" })
      .drawText("Rozsudok stored decision text", { x: 72, y: 720, size: 12 });
    const bytes = await pdf.save();
    const expected =
      (
        await parsePendingDocument(
          {
            caseNumber: decision.caseNumber,
            court: decision.court,
            ecli: decision.ecli ?? null,
            decisionDate: decision.decisionDate ?? null,
            decisionType: decision.decisionType ?? null,
          },
          bytes,
        )
      ).unwrap("Fixture PDF must parse before replay") ??
      panic("Fixture PDF must contain document text");
    const parts =
      decodeSourceRawEnvelope(decision.sourceRaw ?? "") ??
      panic("Fixture envelope missing");
    const legacy = JSON.stringify({
      listItem: JSON.parse(parts["listing"] ?? "null"),
      detail: JSON.parse(parts["detail"] ?? "null"),
    });
    for (const raw of [decision.sourceRaw ?? "", legacy]) {
      const memory = memorySkDocumentRawStorage();
      const capture = await captureSkDocumentRaw({
        sourceId: createSafeId<"caseLawSource">(),
        decisionId: createSafeId<"caseLawDecision">(),
        window: openRawSourceWriteWindow(),
        storedKey: null,
        storedContentType: null,
        inlineRaw: raw,
        bytes,
        signal: new AbortController().signal,
        storage: memory.storage,
        beforeRemoteEffect: async <T>(effect: () => Promise<T>) =>
          await effect(),
      });
      expect(Result.isOk(capture)).toBe(true);
      if (Result.isError(capture)) {
        return;
      }
      const envelope = new TextDecoder().decode(
        memory.objects.get(capture.value.sourceRawS3Key),
      );
      const input = {
        ...storedInput(decision, envelope),
        readObject: async (key: string) =>
          Result.ok(memory.objects.get(key) ?? null),
      };
      rejectPublisherReads();
      const first = await replay(input);
      expect(first.type).toBe("parsed");
      if (first.type !== "parsed") {
        panic("Stored document must parse");
      }
      expect(first.result).toMatchObject(expected);
      expect(first.result.parserVersion).toBe(
        PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
      );
      expect(first.result.documentAst.blocks.length).toBeGreaterThan(0);
      expect(first.result.sourceRaw).toBe(envelope);
      expect(first.result.caseNumber).toBe(decision.caseNumber);
      const second = await replay({
        ...input,
        raw: new TextEncoder().encode(first.result.sourceRaw),
      });
      expect(second).toEqual(first);
    }
  });

  test("a stored envelope without a captured PDF has a typed metadata-only outcome", async () => {
    const decision = await skCourtsFixture().buildDecision();
    const raw = decision.sourceRaw ?? panic("Fixture envelope missing");
    rejectPublisherReads();
    const result = await replay(storedInput(decision, raw));
    expect(result).toMatchObject({
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      status: STORED_RAW_REPLAY_STATUS.METADATA_ONLY,
    });
    const legacy = encodeSourceRawEnvelope({
      legacy: JSON.stringify({
        listItem: JSON.parse(
          decodeSourceRawEnvelope(raw)?.["listing"] ?? "null",
        ),
        detail: JSON.parse(decodeSourceRawEnvelope(raw)?.["detail"] ?? "null"),
      }),
    });
    expect(await replay(storedInput(decision, legacy))).toMatchObject({
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      status: STORED_RAW_REPLAY_STATUS.METADATA_ONLY,
    });
  });

  test("SK courts never advances the document parser without captured layout", async () => {
    const decision = await skCourtsFixture().buildDecision();
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("First paragraph of", { x: 72, y: 720, size: 12 });
    page.drawText("the judgment.", { x: 72, y: 706, size: 12 });
    page.drawText("Second paragraph of", { x: 72, y: 668, size: 12 });
    page.drawText("the judgment.", { x: 72, y: 654, size: 12 });
    const bytes = await pdf.save();
    const emptyPdf = PDF.create();
    emptyPdf.addPage({ size: "letter" });
    const emptyBytes = await emptyPdf.save();
    const parts =
      decodeSourceRawEnvelope(decision.sourceRaw ?? "") ??
      panic("Fixture envelope missing");
    const legacy = JSON.stringify({
      listItem: JSON.parse(parts["listing"] ?? "null"),
      detail: JSON.parse(parts["detail"] ?? "null"),
    });
    await assertProperty(
      "SK courts never advances the document parser without captured layout",
      fc.asyncProperty(
        fc.boolean(),
        fc.constantFrom(
          "captured",
          "missing-object",
          "uncaptured",
          "empty-document",
        ),
        async (useLegacy, captureState) => {
          const raw = useLegacy ? legacy : (decision.sourceRaw ?? "");
          const memory = memorySkDocumentRawStorage();
          const capture = (
            await captureSkDocumentRaw({
              sourceId: createSafeId<"caseLawSource">(),
              decisionId: createSafeId<"caseLawDecision">(),
              window: openRawSourceWriteWindow(),
              storedKey: null,
              storedContentType: null,
              inlineRaw: raw,
              bytes: captureState === "empty-document" ? emptyBytes : bytes,
              signal: new AbortController().signal,
              storage: memory.storage,
              beforeRemoteEffect: async <T>(effect: () => Promise<T>) =>
                await effect(),
            })
          ).unwrap("Fixture capture must succeed");
          const envelope =
            captureState === "uncaptured"
              ? raw
              : new TextDecoder().decode(
                  memory.objects.get(capture.sourceRawS3Key),
                );
          rejectPublisherReads();
          const outcome = await replay({
            ...storedInput(decision, envelope),
            contentType:
              captureState === "uncaptured" && useLegacy
                ? "application/json"
                : SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
            readObject: async (key: string) =>
              Result.ok(
                captureState === "captured" || captureState === "empty-document"
                  ? (memory.objects.get(key) ?? null)
                  : null,
              ),
          });
          if (captureState === "empty-document") {
            expect(outcome).toMatchObject({
              type: "rejected",
              rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
            });
            expect(outcome).not.toHaveProperty("result");
            return;
          }
          if (captureState !== "captured") {
            expect(outcome).toMatchObject({
              type: "rejected",
              rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
              status: STORED_RAW_REPLAY_STATUS.METADATA_ONLY,
            });
            expect(outcome).not.toHaveProperty("result");
            return;
          }
          expect(outcome.type).toBe("parsed");
          if (outcome.type !== "parsed") {
            panic("Captured PDF must rebuild layout");
          }
          expect(outcome.result.parserVersion).toBe(
            PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
          );
          expect(outcome.result.fulltext).toContain(
            "First paragraph of the judgment.\n\nSecond paragraph of the judgment.",
          );
          expect(
            outcome.result.documentAst.blocks.length,
          ).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 24 },
    );
  });
});
