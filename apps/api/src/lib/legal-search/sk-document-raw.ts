// parser-output-unchanged: retain fetched PDF bodies without changing document parsing.
import { Result, TaggedError } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { DOCUMENT_RAW_CAPTURE } from "@/api/lib/legal-search/document-raw-capture";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  RAW_SOURCE_FAMILY,
  type RawSourceWriteFailure,
  type RawSourceWriteWindow,
  writeCaseLawRawPayload,
  writeSourceBinary,
} from "@/api/lib/legal-search/raw-source-storage";
import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { LIMITS } from "@/api/lib/limits";
import { readS3ObjectBoundedIfPresent } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export const SK_DOCUMENT_RAW_PART =
  DOCUMENT_RAW_CAPTURE[ADAPTER_KEYS.SK_COURTS].objectPart;

export class SkDocumentRawMissingError extends TaggedError(
  "SkDocumentRawMissingError",
)<{ message: string; key: string }> {}

export class SkDocumentRawStorageError extends TaggedError(
  "SkDocumentRawStorageError",
)<{ message: string; cause: unknown }> {}

/** The external storage boundary; tests supply an in-memory object store. */
export type SkDocumentRawStorage = {
  read: typeof readS3ObjectBoundedIfPresent;
  writeBinary: typeof writeSourceBinary;
  writeEnvelope: typeof writeCaseLawRawPayload;
};

export const skDocumentRawStorage: SkDocumentRawStorage = {
  read: readS3ObjectBoundedIfPresent,
  writeBinary: writeSourceBinary,
  writeEnvelope: writeCaseLawRawPayload,
};

export type CapturedSkDocumentRaw = {
  sourceRawS3Key: string;
  sourceRawContentType: typeof SOURCE_RAW_ENVELOPE_CONTENT_TYPE;
};

type CaptureSkDocumentRawOptions = {
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  window: RawSourceWriteWindow;
  storedKey: string | null;
  storedContentType: string | null;
  inlineRaw: string | null;
  bytes: Uint8Array;
  signal: AbortSignal;
  storage: SkDocumentRawStorage;
  beforeRemoteEffect: <T>(effect: () => Promise<T>) => Promise<T>;
};

/** Write the file before its envelope; the caller settles the returned pointer. */
export const captureSkDocumentRaw = async ({
  sourceId,
  decisionId,
  window,
  storedKey,
  storedContentType,
  inlineRaw,
  bytes,
  signal,
  storage,
  beforeRemoteEffect,
}: CaptureSkDocumentRawOptions): Promise<
  Result<
    CapturedSkDocumentRaw,
    | RawSourceWriteFailure
    | SkDocumentRawMissingError
    | SkDocumentRawStorageError
  >
> => {
  const captured = await Result.tryPromise({
    try: async () => {
      const stored =
        storedKey === null
          ? null
          : await beforeRemoteEffect(
              async () =>
                await storage.read({
                  key: storedKey,
                  maxBytes: LIMITS.corpusPayloadMaxDecompressedBytes,
                  signal,
                }),
            );
      if (storedKey !== null && stored === null) {
        return Result.err(
          new SkDocumentRawMissingError({
            message: "Stored source envelope is absent",
            key: storedKey,
          }),
        );
      }
      const raw =
        stored === null ? inlineRaw : new TextDecoder().decode(stored);
      // Older rows retain their original wrapper verbatim, beside the new file.
      const parts =
        raw === null ? {} : (decodeSourceRawEnvelope(raw) ?? { legacy: raw });
      const objects = raw === null ? {} : decodeSourceRawEnvelopeObjects(raw);
      const owner = {
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId,
        documentId: decisionId,
      } as const;
      const file = await beforeRemoteEffect(
        async () =>
          await storage.writeBinary({
            ...owner,
            bytes,
            contentType: PDF_MIME_TYPE,
            window,
            signal,
          }),
      );
      if (Result.isError(file)) {
        return Result.err(file.error);
      }
      const envelope = encodeSourceRawEnvelope(parts, {
        ...objects,
        [SK_DOCUMENT_RAW_PART]: file.value,
      });
      const written = await beforeRemoteEffect(
        async () =>
          await storage.writeEnvelope({
            owner,
            window,
            data: envelope,
            contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
            storedKey,
            storedContentType,
            signal,
          }),
      );
      if (Result.isError(written)) {
        return Result.err(written.error);
      }
      return Result.ok({
        sourceRawS3Key: written.value,
        sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      } as const satisfies CapturedSkDocumentRaw);
    },
    catch: (cause) =>
      new SkDocumentRawStorageError({
        message: "Deferred document raw storage failed",
        cause,
      }),
  });
  return captured.andThen((result) => result);
};
