import { Result } from "better-result";

import { envBase } from "@/api/env-base";
import { StoredRawReadError } from "@/api/handlers/case-law/ingestion/adapter";
import type { StoredRawResultReader } from "@/api/handlers/case-law/ingestion/adapter";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  encodeSourceRawEnvelope,
} from "@/api/lib/legal-search/ingestion-types";
import { LIMITS } from "@/api/lib/limits";
import {
  isMissingS3ObjectError,
  readS3ObjectBounded,
  S3ObjectBudgetError,
} from "@/api/lib/s3";

/** A stored payload is one document; nothing here should take longer. */
const STORED_RAW_READ_TIMEOUT_MS = 30_000;

/**
 * The production reader of stored raw payloads. `null` only where the store
 * confirmed it holds no such object; any other failure is raised, so a
 * supplement is parked for another attempt rather than stored as if its
 * judgment had no payload.
 */
export const readStoredRawFromS3: StoredRawResultReader = async (key) => {
  const read = await Result.tryPromise({
    try: async () =>
      await readS3ObjectBounded({
        bucket: envBase.S3_BUCKET,
        key,
        maxBytes: LIMITS.corpusPayloadMaxDecompressedBytes,
        signal: AbortSignal.timeout(STORED_RAW_READ_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  });
  if (Result.isOk(read)) {
    return Result.ok(read.value);
  }
  if (isMissingS3ObjectError(read.error)) {
    return Result.ok(null);
  }
  return Result.err(
    new StoredRawReadError({
      message: `Stored payload read failed for ${key}`,
      key,
      cause: read.error,
      permanent: read.error instanceof S3ObjectBudgetError,
    }),
  );
};

/** Rebuild a fingerprint input from the raw payload and files stored for it. */
export const sourceFingerprintFromStoredRaw = async (
  key: string,
): Promise<ReturnType<typeof sourceFingerprint>> => {
  const payload = await readS3ObjectBounded({
    bucket: envBase.S3_BUCKET,
    key,
    maxBytes: LIMITS.corpusPayloadMaxDecompressedBytes,
    signal: AbortSignal.timeout(STORED_RAW_READ_TIMEOUT_MS),
  });
  const storedEnvelope = new TextDecoder().decode(payload);
  const parts = decodeSourceRawEnvelope(storedEnvelope);
  const references = decodeSourceRawEnvelopeObjects(storedEnvelope);
  const sourceRaw =
    parts === null ? storedEnvelope : encodeSourceRawEnvelope(parts);
  const sourceRawObjects = Object.fromEntries(
    await Promise.all(
      Object.entries(references).map(async ([part, reference]) => {
        const location = parseCorpusLocation(reference.location);
        if (location.type !== "object") {
          return await Promise.reject(
            new StoredRawReadError({
              message: `Stored raw object is not independently readable: ${reference.location}`,
              key: reference.location,
              cause: null,
              permanent: true,
            }),
          );
        }
        const bytes = await readS3ObjectBounded({
          bucket: envBase.S3_BUCKET,
          key: location.key,
          maxBytes: LIMITS.corpusPayloadMaxDecompressedBytes,
          signal: AbortSignal.timeout(STORED_RAW_READ_TIMEOUT_MS),
        });
        return [part, { bytes, contentType: reference.contentType }] as const;
      }),
    ),
  );
  return sourceFingerprint({ sourceRaw, sourceRawObjects });
};
