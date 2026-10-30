import { panic, Result } from "better-result";

import { createSafeId } from "@/api/lib/branded-types";
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

/** Real deferred raw writer, with a complete body its PDF parser cannot read. */
export const deferredSkDocumentRawFixture = async (
  inlineRaw = encodeSourceRawEnvelope({ listing: '{"id":1}' }),
) => {
  const memory = memorySkDocumentRawStorage();
  const bytes = new TextEncoder().encode("%PDF-1.7 not a pdf");
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
