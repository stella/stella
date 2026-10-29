import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import {
  captureSkDocumentRaw,
  SK_DOCUMENT_RAW_PART,
  SkDocumentRawMissingError,
} from "@/api/lib/legal-search/sk-document-raw";
import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { memorySkDocumentRawStorage } from "@/api/tests/helpers/sk-document-raw-storage";

const bytes = new TextEncoder().encode("%PDF-1.7 not a pdf");

describe("deferred document raw capture", () => {
  test("retains every complete body independently of PDF parsing and preserves the envelope", async () => {
    const memory = memorySkDocumentRawStorage();
    const parts = { listing: '{"id":1}', detail: '{"id":2}' };
    const raw = encodeSourceRawEnvelope(parts);
    const options = {
      sourceId: createSafeId<"caseLawSource">(),
      decisionId: createSafeId<"caseLawDecision">(),
      window: openRawSourceWriteWindow(),
      storedKey: null,
      storedContentType: null,
      inlineRaw: raw,
      bytes,
      signal: new AbortController().signal,
      storage: memory.storage,
      beforeRemoteEffect: async <T>(effect: () => Promise<T>) => await effect(),
    };
    const captured = await captureSkDocumentRaw(options);
    expect(Result.isOk(captured)).toBe(true);
    if (Result.isError(captured)) {
      return;
    }
    const written = captured.value;
    const envelope = new TextDecoder().decode(
      memory.objects.get(written.sourceRawS3Key),
    );
    expect(decodeSourceRawEnvelope(envelope)).toEqual(parts);
    const ref =
      decodeSourceRawEnvelopeObjects(envelope)[SK_DOCUMENT_RAW_PART] ??
      panic("document reference missing");
    expect(memory.objects.get(ref.location)).toEqual(bytes);
    expect(ref.contentType).toBe("application/pdf");
    expect(ref.byteLength).toBe(bytes.byteLength);
    expect(written.sourceRawContentType).toBe(SOURCE_RAW_ENVELOPE_CONTENT_TYPE);
    const replayed = await captureSkDocumentRaw({
      ...options,
      window: openRawSourceWriteWindow(),
      storedKey: written.sourceRawS3Key,
      storedContentType: written.sourceRawContentType,
    });
    expect(replayed).toEqual(Result.ok(written));
    expect(memory.objects.size).toBe(2);
  });

  test("keeps an older wrapper verbatim beside the fetched object", async () => {
    const memory = memorySkDocumentRawStorage();
    const raw = '{ "listItem": {"id": 1}, "detail": null }';
    const capture = await captureSkDocumentRaw({
      sourceId: createSafeId<"caseLawSource">(),
      decisionId: createSafeId<"caseLawDecision">(),
      window: openRawSourceWriteWindow(),
      storedKey: null,
      storedContentType: "application/json",
      inlineRaw: raw,
      bytes,
      signal: new AbortController().signal,
      storage: memory.storage,
      beforeRemoteEffect: async <T>(effect: () => Promise<T>) => await effect(),
    });
    expect(Result.isOk(capture)).toBe(true);
    if (Result.isError(capture)) {
      return;
    }
    const written = capture.value;
    expect(
      decodeSourceRawEnvelope(
        new TextDecoder().decode(memory.objects.get(written.sourceRawS3Key)),
      ),
    ).toEqual({ legacy: raw });
  });

  test("a missing stored envelope refuses capture instead of replacing the prior observation", async () => {
    const memory = memorySkDocumentRawStorage();
    const result = await captureSkDocumentRaw({
      sourceId: createSafeId<"caseLawSource">(),
      decisionId: createSafeId<"caseLawDecision">(),
      window: openRawSourceWriteWindow(),
      storedKey: "missing-envelope",
      storedContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      inlineRaw: null,
      bytes,
      signal: new AbortController().signal,
      storage: memory.storage,
      beforeRemoteEffect: async <T>(effect: () => Promise<T>) => await effect(),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error).toBeInstanceOf(SkDocumentRawMissingError);
    expect(memory.objects.size).toBe(0);
  });
});
