import type { FileKey } from "@/api/lib/file-key";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";
import { getS3ObjectWithSignal, readS3ArrayBuffer } from "@/api/lib/s3";
import type { S3SigningScope } from "@/api/lib/s3-presign";
import { readTenantS3ArrayBuffer } from "@/api/lib/s3-presign";

type ReadStoredFileInput = {
  key: FileKey;
  mimeType: string;
  fileName?: string;
} & (
  | { scope?: undefined; signal?: AbortSignal }
  /** Read through the tenant client, refusing keys outside this scope. */
  | { scope: S3SigningScope; signal: AbortSignal }
);

const readBytes = async (input: ReadStoredFileInput): Promise<ArrayBuffer> => {
  if (input.scope !== undefined) {
    return await readTenantS3ArrayBuffer({
      key: input.key,
      scope: input.scope,
      signal: input.signal,
    });
  }
  return input.signal === undefined
    ? await readS3ArrayBuffer(input.key)
    : await getS3ObjectWithSignal(input.key, input.signal);
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
