import { envBase } from "@/api/env-base";
import type { FileKey } from "@/api/lib/file-key";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { OBJECT_READ_TIMEOUT_MS, readS3ObjectBounded } from "@/api/lib/s3";
import type { S3SigningScope } from "@/api/lib/s3-presign";
import { readTenantS3ArrayBuffer } from "@/api/lib/s3-presign";

type ReadStoredFileInput = {
  key: FileKey;
  mimeType: string;
  fileName?: string;
} & (
  | { scope?: undefined; signal?: AbortSignal; maxBytes?: undefined }
  | { scope?: undefined; signal: AbortSignal; maxBytes: number }
  /** Read through the tenant client, refusing keys outside this scope. */
  | { scope: S3SigningScope; signal: AbortSignal; maxBytes?: undefined }
);

const readBytes = async (input: ReadStoredFileInput): Promise<ArrayBuffer> => {
  if (input.scope !== undefined) {
    return await readTenantS3ArrayBuffer({
      key: input.key,
      scope: input.scope,
      signal: input.signal,
    });
  }
  const bytes = await readS3ObjectBounded({
    bucket: envBase.S3_BUCKET,
    key: input.key,
    maxBytes: input.maxBytes ?? FILE_SIZE_LIMIT_BYTES.document,
    // Only the legacy unconfigured path supplied its own five-minute deadline.
    signal:
      input.maxBytes === undefined
        ? (input.signal ?? AbortSignal.timeout(OBJECT_READ_TIMEOUT_MS))
        : input.signal,
  });
  // The read is the only holder of `bytes`, so an exact-fit buffer is
  // handed on as-is rather than copied a second time.
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
};

/**
 * Reads a file key from the documents bucket as a `ScannedFile`. Objects reach
 * a file key only after a scan or as server-built derivatives of one, so the
 * bytes this function reads itself need no second scan.
 */
export const readStoredFile = async (
  input: ReadStoredFileInput,
): Promise<ScannedFile> =>
  mintScannedFile({
    bytes: await readBytes(input),
    fileName: input.fileName ?? input.key,
    mimeType: input.mimeType,
    source: { type: "stored", key: input.key },
  });
