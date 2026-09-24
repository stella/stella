import { Result } from "better-result";

import { envBase } from "@/api/env-base";
import { StoredRawReadError } from "@/api/handlers/case-law/ingestion/adapter";
import type { StoredRawResultReader } from "@/api/handlers/case-law/ingestion/adapter";
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
