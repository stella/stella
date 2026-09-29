/**
 * Stored files whose own row records whether their bytes were scanned.
 *
 * Templates and style sets keep their files under keys their rows name, and
 * each row carries a scan state beside the key. `writeScannedObject` is the
 * only way to a `scanned` reference: it stores the bytes of a `ScannedFile`.
 * A row whose state is `unscanned` (one written before scan states were
 * recorded) is scanned by `readStoredObject` on its next read, then marked, so
 * its bytes reach a parser only after the same scan every upload passes.
 *
 * `storedObject` reads a row back into a reference, trusting the row's state;
 * the `scanned-file-boundary` lint rule lets only the modules that own those
 * rows import it.
 */
import { panic, Result } from "better-result";
import * as v from "valibot";

import type { SafeDbError } from "@/api/db/safe-db";
import type { StoredFileScanState } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { fileKeySchema } from "@/api/lib/file-key";
import type { FileKey } from "@/api/lib/file-key";
import { scanUpload } from "@/api/lib/file-scan/scan-upload";
import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { readS3ObjectBounded, writeS3ObjectWithRetry } from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";

const UNSCANNED_READ_TIMEOUT_MS = 30_000;

const SCAN_STATE_RECORD_FAILED_SINK = failureSink({
  event: "stored_object.scan_state_record_failed",
  expected: [],
});

export type ScannedObject = { scanState: "scanned"; key: FileKey };

export type StoredObject =
  | ScannedObject
  | { scanState: "unscanned"; key: string };

type StoredObjectRow = { key: string; scanState: StoredFileScanState };

/** A row's key and scan state as a reference its reader can act on. */
export const storedObject = ({
  key,
  scanState,
}: StoredObjectRow): StoredObject => {
  switch (scanState) {
    case "scanned":
      return { scanState, key: v.parse(fileKeySchema, key) };
    case "unscanned":
      return { scanState, key };
    default:
      scanState satisfies never;
      return panic(`Unhandled stored file scan state: ${String(scanState)}`);
  }
};

type WriteScannedObjectInput = {
  file: ScannedFile;
  key: string;
  write?: typeof writeS3ObjectWithRetry;
};

type WrittenScannedObject = {
  certainty: S3ObjectWriteCertainty;
  object: ScannedObject;
};

/** Stores a scanned file's bytes; the reference is what its row records. */
export const writeScannedObject = async ({
  file,
  key,
  write = writeS3ObjectWithRetry,
}: WriteScannedObjectInput): Promise<WrittenScannedObject> => ({
  certainty: await write({
    key,
    data: new Uint8Array(file.bytes),
    contentType: file.mimeType,
  }),
  object: { scanState: "scanned", key: v.parse(fileKeySchema, key) },
});

type ReadStoredObjectInput = {
  object: StoredObject;
  fileName: string;
  mimeType: string;
  /** Records that the row's bytes passed; later reads then skip the scan. */
  markScanned: (object: ScannedObject) => Promise<Result<void, SafeDbError>>;
  scan?: typeof scanUpload | undefined;
};

/**
 * The stored bytes as a `ScannedFile`. An `unscanned` object is scanned first:
 * a rejection or a scanner failure comes back as the error and nothing is
 * marked, so the next read scans again.
 */
export const readStoredObject = async ({
  object,
  fileName,
  mimeType,
  markScanned,
  scan = scanUpload,
}: ReadStoredObjectInput): Promise<
  Result<ScannedFile, FileScanRejectedError | FileScanFailedError>
> => {
  switch (object.scanState) {
    case "scanned":
      return Result.ok(
        await readStoredFile({ key: object.key, fileName, mimeType }),
      );
    case "unscanned": {
      // Stored files were uploads first, so none may exceed an upload's size.
      const scanned = await scan({
        bytes: await readS3ObjectBounded({
          bucket: envBase.S3_BUCKET,
          key: object.key,
          maxBytes: FILE_SIZE_LIMIT_BYTES.document,
          signal: AbortSignal.timeout(UNSCANNED_READ_TIMEOUT_MS),
        }),
        declaredMimeType: mimeType,
        fileName,
      });
      if (Result.isError(scanned)) {
        return scanned;
      }
      const marked = await markScanned({
        scanState: "scanned",
        key: v.parse(fileKeySchema, object.key),
      });
      // The bytes passed either way; an unrecorded verdict only costs the next
      // read another scan.
      if (Result.isError(marked)) {
        observeFailure(marked.error, { sink: SCAN_STATE_RECORD_FAILED_SINK });
      }
      return scanned;
    }
    default:
      object satisfies never;
      return panic(`Unhandled stored object: ${String(object)}`);
  }
};
