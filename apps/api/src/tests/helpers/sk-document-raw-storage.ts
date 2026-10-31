import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";

import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { createSafeId } from "@/api/lib/branded-types";
import type { StoredRawReparseInput } from "@/api/lib/legal-search/ingestion-types";
import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/lib/legal-search/ingestion-types";
import {
  openRawSourceWriteWindow,
  rawSourcePayloadKey,
  sourceBinaryRef,
} from "@/api/lib/legal-search/raw-source-storage";
import type { SkDocumentRawStorage } from "@/api/lib/legal-search/sk-document-raw";
import { captureSkDocumentRaw } from "@/api/lib/legal-search/sk-document-raw";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

export const memorySkDocumentRawStorage = () => {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    read: async ({ key }) => await Promise.resolve(objects.get(key) ?? null),
    writeBinary: async (input) => {
      const ref = sourceBinaryRef(input);
      objects.set(ref.location, input.bytes);
      return await Promise.resolve(Result.ok(ref));
    },
    writeEnvelope: async (input) => {
      const key = rawSourcePayloadKey(input);
      objects.set(
        key,
        typeof input.data === "string"
          ? new TextEncoder().encode(input.data)
          : input.data,
      );
      return await Promise.resolve(Result.ok(key));
    },
  } satisfies SkDocumentRawStorage;
  return { storage, objects };
};

/** Real deferred raw writer; the default body exercises an unreadable captured PDF. */
export const deferredSkDocumentRawFixture = async (
  inlineRaw = encodeSourceRawEnvelope({ listing: '{"id":1}' }),
  bytes: Uint8Array = new TextEncoder().encode("%PDF-1.7 not a pdf"),
) => {
  const memory = memorySkDocumentRawStorage();
  const capture = await captureSkDocumentRaw({
    sourceId: createSafeId<"caseLawSource">(),
    decisionId: createSafeId<"caseLawDecision">(),
    window: openRawSourceWriteWindow(),
    storedKey: null,
    storedContentType: null,
    inlineRaw,
    bytes,
    signal: new AbortController().signal,
    storage: memory.storage,
    beforeRemoteEffect: async <T>(effect: () => Promise<T>) => await effect(),
  });
  if (Result.isError(capture)) {
    return panic("Deferred raw fixture must capture its bytes", capture.error);
  }
  return {
    raw: new TextDecoder().decode(
      memory.objects.get(capture.value.sourceRawS3Key),
    ),
    objects: memory.objects,
    bytes,
  };
};

/** Supply a real captured PDF when metadata assertions drive the public replay boundary. */
export const capturedSkDocumentReplayInput = async (
  stored: StoredRawReparseInput,
) => {
  const pdf = PDF.create();
  pdf
    .addPage({ size: "letter" })
    .drawText("Stored decision text.", { x: 72, y: 720, size: 12 });
  const captured = await deferredSkDocumentRawFixture(
    new TextDecoder().decode(stored.raw),
    await pdf.save(),
  );
  return {
    raw: new TextEncoder().encode(captured.raw),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    caseNumber: stored.caseNumber,
    sourceDocumentId: stored.sourceDocumentId,
    language: stored.language,
    court: stored.court,
    ecli: stored.ecli,
    decisionDate: stored.decisionDate,
    decisionType: stored.decisionType,
    sourceUrl: stored.sourceUrl,
    documentUrl: stored.documentUrl,
    metadata: stored.metadata,
    readObject: (key) =>
      Promise.resolve(Result.ok(captured.objects.get(key) ?? null)),
  } satisfies StoredRawReparseInput;
};

export const replayCapturedSkDocument = async (
  stored: StoredRawReparseInput,
) => {
  const replay =
    skCourtsAdapter.reparseStoredRaw ?? panic("SK courts replay required");
  return await replay(await capturedSkDocumentReplayInput(stored));
};
