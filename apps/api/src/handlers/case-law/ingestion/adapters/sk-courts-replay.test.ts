import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  IngestionResult,
  StoredRawReparseInput,
} from "@/api/handlers/case-law/ingestion/adapter";
import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { createSafeId } from "@/api/lib/branded-types";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { parsePendingDocument } from "@/api/lib/legal-search/sk-document-parser";
import { captureSkDocumentRaw } from "@/api/lib/legal-search/sk-document-raw";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { skCourtsFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { memorySkDocumentRawStorage } from "@/api/tests/helpers/sk-document-raw-storage";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
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
  globalThis.fetch = asFetchMock(async () =>
    panic("Stored replay cannot fetch publisher responses"),
  );
};

describe("SK courts stored document replay", () => {
  test("stored document objects reproduce the deferred parser and form a fixed point", async () => {
    const decision = await skCourtsFixture().buildDecision();
    const pdf = PDF.create();
    pdf
      .addPage({ size: "letter" })
      .drawText("Rozsudok stored decision text", { x: 72, y: 720, size: 12 });
    const bytes = await pdf.save();
    const expected =
      (await parsePendingDocument(
        {
          caseNumber: decision.caseNumber,
          court: decision.court,
          ecli: decision.ecli ?? null,
          decisionDate: decision.decisionDate ?? null,
          decisionType: decision.decisionType ?? null,
        },
        bytes,
      )) ?? panic("Fixture PDF must parse before replay");
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
      expect(first.result.sourceRaw).toBe(envelope);
      expect(first.result.caseNumber).toBe(decision.caseNumber);
      const second = await replay({
        ...input,
        raw: new TextEncoder().encode(first.result.sourceRaw),
      });
      expect(second).toEqual(first);
    }
  });

  test("a stored envelope without a document object is metadata-only", async () => {
    const decision = await skCourtsFixture().buildDecision();
    const raw = decision.sourceRaw ?? panic("Fixture envelope missing");
    rejectPublisherReads();
    const result = await replay(storedInput(decision, raw));
    expect(result).toMatchObject({
      type: "rejected",
      rejection: "incomplete-metadata",
      status: "metadata-only",
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
      rejection: "incomplete-metadata",
      status: "metadata-only",
    });
  });
});
