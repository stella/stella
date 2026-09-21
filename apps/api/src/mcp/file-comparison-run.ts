/**
 * The `uploads` source of `compare_documents`: redline two DOCX files stella
 * does not store. The bytes arrive through `prepare_file_comparison`'s signed
 * PUTs, are verified and scanned exactly as a document upload is, compared by
 * the same buffer-level comparison the stored-version path runs, and returned
 * as one temporary link. Nothing here becomes a document, a version, or matter
 * content, and every object and row is deleted or expires.
 */

import { panic, Result } from "better-result";
import { and, eq, gt, inArray } from "drizzle-orm";

import type { CompareResult } from "@stll/folio-core";
import { Temporal } from "@stll/time";

import { fileComparisonUploads } from "@/api/db/schema";
import {
  compareDocxBuffers,
  DOCUMENT_COMPARE_READ_TIMEOUT_MS,
  redlineFileName,
} from "@/api/handlers/documents/compare";
import type {
  CompareFailure,
  CompareGranularity,
  CompareMode,
  TrackedChangeDisposition,
} from "@/api/handlers/documents/compare";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveDocxEditAuthorName } from "@/api/lib/entity-versions/resolve-docx-edit-author-name";
import { fileSecurityRejection } from "@/api/lib/file-scan/rejection";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { deleteS3ObjectWithSignal, readS3ArrayBuffer } from "@/api/lib/s3";
import { headObject } from "@/api/lib/s3-presign";
import {
  DEFAULT_DELIVER_TEMPORARY_REDLINE_DEPENDENCIES,
  deliverTemporaryRedline,
  TEMPORARY_REDLINE_FAILURE_MESSAGE,
} from "@/api/lib/uploads/file-comparison/deliver-redline";
import type {
  DeliverTemporaryRedlineDependencies,
  TemporaryRedlineDelivery,
} from "@/api/lib/uploads/file-comparison/deliver-redline";
import { fileComparisonObjectKey } from "@/api/lib/uploads/file-comparison/uploads";
import { sha256Base64ToHex } from "@/api/lib/uploads/runtime";
import { withTimeout } from "@/api/lib/with-timeout";
import type { McpRequestContext } from "@/api/mcp/context";
import type { InternalToolErrorResult } from "@/api/mcp/tool-types";
import { notFoundResult, structuredErrorResult } from "@/api/mcp/tool-utils";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const PREPARE_HINT =
  "Call prepare_file_comparison, PUT both files to the urls it returns, then " +
  "pass its next.source back to compare_documents.";

/**
 * `preview` reports the change summary and writes nothing; `download` writes
 * the redline to temporary storage and returns a link. `version` is not one of
 * them: an uploads comparison has no document to save a version into.
 */
export const UPLOADS_OUTPUT_MODES = ["preview", "download"] as const;

type UploadsOutputMode = (typeof UPLOADS_OUTPUT_MODES)[number];

export type FileComparisonRunDependencies = {
  compareDocxBuffers: typeof compareDocxBuffers;
  deleteObject: typeof deleteS3ObjectWithSignal;
  headObject: typeof headObject;
  readObject: typeof readS3ArrayBuffer;
  resolveDocxEditAuthorName: typeof resolveDocxEditAuthorName;
  scanFile: typeof scanFile;
} & DeliverTemporaryRedlineDependencies;

const DEFAULT_FILE_COMPARISON_RUN_DEPENDENCIES: FileComparisonRunDependencies =
  {
    ...DEFAULT_DELIVER_TEMPORARY_REDLINE_DEPENDENCIES,
    compareDocxBuffers,
    deleteObject: deleteS3ObjectWithSignal,
    headObject,
    readObject: readS3ArrayBuffer,
    resolveDocxEditAuthorName,
    scanFile,
  };

export type FileComparisonRunOptions = {
  baseTrackedChanges: TrackedChangeDisposition;
  baseUploadId: SafeId<"fileComparisonUpload">;
  context: McpRequestContext;
  granularity: CompareGranularity;
  mode: CompareMode;
  outputMode: UploadsOutputMode;
  signal: AbortSignal;
  targetTrackedChanges: TrackedChangeDisposition;
  targetUploadId: SafeId<"fileComparisonUpload">;
};

type InputRow = {
  declaredName: string;
  declaredSha256: string | null;
  declaredSize: number;
  id: SafeId<"fileComparisonUpload">;
};

type LoadedInput = {
  buffer: ArrayBuffer;
  /** Null is the scanner's "nothing to warn about". */
  warnings: string[] | null;
};

export type FileComparisonRunResult =
  | {
      status: "upload_downloadable";
      baseUploadId: string;
      comparison: CompareResult;
      download: TemporaryRedlineDelivery;
      fileName: string;
      scanWarnings: string[];
      targetUploadId: string;
    }
  | {
      status: "upload_previewed";
      baseUploadId: string;
      comparison: CompareResult;
      scanWarnings: string[];
      targetUploadId: string;
    }
  | {
      status: "upload_failed";
      baseUploadId: string;
      error: CompareFailure;
      targetUploadId: string;
    };

export type FileComparisonRunOutcome =
  | { status: "ok"; result: FileComparisonRunResult }
  | { status: "error"; response: InternalToolErrorResult };

/**
 * Drop one staged object and its row. The object goes first: a row removed
 * before its object leaves bytes nothing can name, while an object removed
 * before its row leaves a row the expiry sweep clears on its next tick, which
 * is why the row is expired now rather than left on its original deadline.
 */
const discardInput = async ({
  context,
  deleteObject,
  signal,
  status,
  uploadId,
}: {
  context: McpRequestContext;
  deleteObject: FileComparisonRunDependencies["deleteObject"];
  signal: AbortSignal;
  status: "consumed" | "failed";
  uploadId: SafeId<"fileComparisonUpload">;
}): Promise<void> => {
  const key = fileComparisonObjectKey({
    organizationId: context.organizationId,
    uploadId,
  });
  const marked = await Result.tryPromise(
    async () =>
      await context.scopedDb(async (tx) => {
        // audit: skip — the comparison's own event answers for both inputs.
        await tx
          .update(fileComparisonUploads)
          .set({ expiresAt: new Date(), status })
          .where(eq(fileComparisonUploads.id, uploadId));
      }),
  );
  if (Result.isError(marked)) {
    return;
  }

  const deleted = await Result.tryPromise(
    async () => await deleteObject(key, signal),
  );
  if (Result.isError(deleted)) {
    // The row stays behind on purpose, so the sweep retries the key.
    return;
  }
  const removed = await Result.tryPromise(
    async () =>
      await context.scopedDb(async (tx) => {
        await tx
          .delete(fileComparisonUploads)
          .where(eq(fileComparisonUploads.id, uploadId));
      }),
  );
  if (Result.isError(removed)) {
    // The object is gone and the row is expired, so the sweep removes it.
    captureError(removed.error, {
      fileComparisonUploadId: uploadId,
      stage: "file-comparison.discard-row",
    });
  }
};

type LoadOutcome =
  | { status: "ok"; loaded: LoadedInput }
  | { status: "error"; response: InternalToolErrorResult };

/**
 * What the object store actually holds, against what the row declared, then
 * the security scan. Both are the checks `uploads/update.ts` runs when it
 * finalizes a document upload: a comparison reads client bytes on the same
 * terms a stored version does.
 */
const loadInput = async ({
  context,
  dependencies,
  path,
  row,
  signal,
}: {
  context: McpRequestContext;
  dependencies: FileComparisonRunDependencies;
  path: string;
  row: InputRow;
  signal: AbortSignal;
}): Promise<LoadOutcome> => {
  const key = fileComparisonObjectKey({
    organizationId: context.organizationId,
    uploadId: row.id,
  });
  const refuse = async (
    message: string,
    hint: string,
  ): Promise<LoadOutcome> => {
    await discardInput({
      context,
      deleteObject: dependencies.deleteObject,
      signal,
      status: "failed",
      uploadId: row.id,
    });
    return {
      status: "error",
      response: structuredErrorResult({
        code: "validation_error",
        message,
        hint,
        issues: [{ path, message }],
      }),
    };
  };

  const head = await dependencies.headObject(key);
  if (Result.isError(head)) {
    return {
      status: "error",
      response: notFoundResult(
        "One of the files to compare was never uploaded",
        `PUT the bytes to the url prepare_file_comparison returned before comparing. ${PREPARE_HINT}`,
      ),
    };
  }
  if (head.value.contentLength !== row.declaredSize) {
    return await refuse(
      `The uploaded file is ${head.value.contentLength} bytes, not the ${row.declaredSize} that were declared`,
      "Reserve the comparison again with this file's real size and checksum, then upload it.",
    );
  }
  const storedSha256 = head.value.checksumSHA256;
  if (
    storedSha256 !== null &&
    sha256Base64ToHex(storedSha256) !== row.declaredSha256
  ) {
    return await refuse(
      "The uploaded file's SHA-256 does not match the one that was declared",
      "Reserve the comparison again with this file's real size and checksum, then upload it.",
    );
  }

  const read = await Result.tryPromise(
    async () =>
      await withTimeout(
        async (operationSignal) =>
          await dependencies.readObject(key, operationSignal),
        {
          label: "file-comparison.read",
          signal,
          timeoutMs: DOCUMENT_COMPARE_READ_TIMEOUT_MS,
        },
      ),
  );
  if (Result.isError(read)) {
    return {
      status: "error",
      response: structuredErrorResult({
        code: "internal_error",
        message: "One of the files to compare could not be read",
        hint: "Retry the comparison; if it repeats, stage the files again.",
        retryable: true,
      }),
    };
  }
  const buffer = read.value;

  // S3 records a checksum only for an upload that sent one. The presign forces
  // that header, so this covers a store that does not return it rather than a
  // client that skipped it.
  if (storedSha256 === null) {
    const uploadedSha256 = new Bun.CryptoHasher("sha256")
      .update(buffer)
      .digest("hex");
    if (uploadedSha256 !== row.declaredSha256) {
      return await refuse(
        "The uploaded file's SHA-256 does not match the one that was declared",
        "Reserve the comparison again with this file's real size and checksum, then upload it.",
      );
    }
  }

  const scanned = await dependencies.scanFile({
    buffer: new Uint8Array(buffer),
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: row.declaredName,
  });
  if (Result.isError(scanned)) {
    return await refuse(
      "One of the files to compare could not be scanned",
      "Retry the comparison; if it repeats, stage the files again.",
    );
  }
  if (scanned.value.verdict === "reject") {
    const rejection = fileSecurityRejection(scanned.value);
    if (rejection === null) {
      panic("Rejecting scan had no rejecting findings");
    }
    await discardInput({
      context,
      deleteObject: dependencies.deleteObject,
      signal,
      status: "failed",
      uploadId: row.id,
    });
    return {
      status: "error",
      response: structuredErrorResult({
        code: "validation_error",
        message: rejection.message,
        hint: rejection.hint,
        issues: rejection.issues.map(({ code, message }) => ({
          path,
          message: `${code}: ${message}`,
        })),
      }),
    };
  }

  return {
    status: "ok",
    loaded: { buffer, warnings: getScanWarnings(scanned.value) },
  };
};

type Delivery = {
  download: TemporaryRedlineDelivery;
  fileName: string;
};

type DeliveryOutcome =
  | { status: "ok"; delivery: Delivery | null }
  | { status: "error"; response: InternalToolErrorResult };

/** Write the redline and hand back a link, or nothing at all in preview mode. */
const deliver = async ({
  compared,
  context,
  dependencies,
  outputMode,
  signal,
  targetName,
}: {
  compared: CompareResult;
  context: McpRequestContext;
  dependencies: FileComparisonRunDependencies;
  outputMode: UploadsOutputMode;
  signal: AbortSignal;
  targetName: string;
}): Promise<DeliveryOutcome> => {
  if (outputMode === "preview") {
    return { status: "ok", delivery: null };
  }

  const fileName = redlineFileName(targetName);
  const delivered = await deliverTemporaryRedline(
    {
      bytes: new Uint8Array(compared.buffer),
      fileName,
      organizationId: context.organizationId,
      scopedDb: context.scopedDb,
      signal,
      userId: context.userId,
    },
    dependencies,
  );
  if (Result.isError(delivered)) {
    captureError(delivered.error.cause, {
      stage: "file-comparison.deliver",
      step: delivered.error.step,
    });
    return {
      status: "error",
      response: structuredErrorResult({
        code: "internal_error",
        message: TEMPORARY_REDLINE_FAILURE_MESSAGE[delivered.error.step],
        hint: "Retry the comparison.",
        retryable: true,
      }),
    };
  }

  return {
    status: "ok",
    delivery: { download: delivered.value, fileName },
  };
};

const recordComparisonAudit = async ({
  base,
  changeCount,
  context,
  target,
}: {
  base: InputRow;
  changeCount: number | null;
  context: McpRequestContext;
  target: InputRow;
}): Promise<void> => {
  const recorded = await Result.tryPromise(
    async () =>
      await context.scopedDb(async (tx) => {
        // Sizes and a count: the file names are the caller's, and the bytes
        // were never this organization's stored content.
        await context.recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.FILE_COMPARISON,
          resourceId: base.id,
          metadata: {
            baseSizeBytes: base.declaredSize,
            baseUploadId: base.id,
            changeCount,
            targetSizeBytes: target.declaredSize,
            targetUploadId: target.id,
          },
          workspaceId: null,
        });
      }),
  );
  if (Result.isError(recorded)) {
    captureError(recorded.error, {
      fileComparisonUploadId: base.id,
      stage: "file-comparison.audit",
    });
  }
};

const loadInputRows = async ({
  baseUploadId,
  context,
  targetUploadId,
}: {
  baseUploadId: SafeId<"fileComparisonUpload">;
  context: McpRequestContext;
  targetUploadId: SafeId<"fileComparisonUpload">;
}): Promise<Result<InputRow[], unknown>> =>
  await Result.tryPromise(
    async () =>
      await context.scopedDb(
        async (tx) =>
          await tx
            .select({
              declaredName: fileComparisonUploads.declaredName,
              declaredSha256: fileComparisonUploads.declaredSha256,
              declaredSize: fileComparisonUploads.declaredSize,
              id: fileComparisonUploads.id,
            })
            .from(fileComparisonUploads)
            .where(
              and(
                inArray(fileComparisonUploads.id, [
                  baseUploadId,
                  targetUploadId,
                ]),
                // RLS pins the same two columns. Repeating them keeps the
                // refusal a `not_found` this query decided, rather than a
                // zero-row read that a policy change could widen.
                eq(fileComparisonUploads.userId, context.userId),
                eq(
                  fileComparisonUploads.organizationId,
                  context.organizationId,
                ),
                eq(fileComparisonUploads.kind, "input"),
                inArray(fileComparisonUploads.status, ["pending", "ready"]),
                gt(fileComparisonUploads.expiresAt, new Date()),
              ),
            )
            .limit(2),
      ),
  );

export const runFileComparison = async (
  {
    baseTrackedChanges,
    baseUploadId,
    context,
    granularity,
    mode,
    outputMode,
    signal,
    targetTrackedChanges,
    targetUploadId,
  }: FileComparisonRunOptions,
  dependencies: FileComparisonRunDependencies = DEFAULT_FILE_COMPARISON_RUN_DEPENDENCIES,
): Promise<FileComparisonRunOutcome> => {
  if (baseUploadId === targetUploadId) {
    return {
      status: "error",
      response: structuredErrorResult({
        code: "validation_error",
        message: "The two files to compare must be different uploads",
        hint: PREPARE_HINT,
        issues: [
          {
            path: "source.target_upload_id",
            message: "Must differ from source.base_upload_id",
          },
        ],
      }),
    };
  }

  const rows = await loadInputRows({ baseUploadId, context, targetUploadId });
  if (Result.isError(rows)) {
    return {
      status: "error",
      response: structuredErrorResult({
        code: "internal_error",
        message: "The staged comparison could not be read",
        hint: "Retry the comparison.",
        retryable: true,
      }),
    };
  }

  const byId = new Map(rows.value.map((row) => [String(row.id), row]));
  const base = byId.get(baseUploadId);
  const target = byId.get(targetUploadId);
  if (base === undefined || target === undefined) {
    return {
      status: "error",
      response: notFoundResult(
        "One of these comparison uploads is unknown, already used, or expired",
        PREPARE_HINT,
      ),
    };
  }

  const author = await dependencies.resolveDocxEditAuthorName({
    safeDb: context.safeDb,
    userId: context.userId,
  });
  if (author === null) {
    return {
      status: "error",
      response: structuredErrorResult({
        code: "validation_error",
        message: "Add a profile name before creating a document comparison",
        hint: "Set your display name in stella, then retry the comparison.",
      }),
    };
  }

  const [loadedBase, loadedTarget] = await Promise.all([
    loadInput({
      context,
      dependencies,
      path: "source.base_upload_id",
      row: base,
      signal,
    }),
    loadInput({
      context,
      dependencies,
      path: "source.target_upload_id",
      row: target,
      signal,
    }),
  ]);
  if (loadedBase.status === "error") {
    return loadedBase;
  }
  if (loadedTarget.status === "error") {
    return loadedTarget;
  }

  const compared = await dependencies.compareDocxBuffers({
    author,
    base: {
      buffer: loadedBase.loaded.buffer,
      trackedChanges: baseTrackedChanges,
    },
    granularity,
    mode,
    signal,
    target: {
      buffer: loadedTarget.loaded.buffer,
      trackedChanges: targetTrackedChanges,
    },
    // The files are not versions, so there is no stored timestamp to stamp the
    // revisions with; the comparison itself is when they were written.
    timestamp: Temporal.Now.instant().toString(),
  });

  /** Read once, then gone, whatever the comparison decided. */
  const consumeInputs = async (): Promise<void> => {
    await Promise.all([
      discardInput({
        context,
        deleteObject: dependencies.deleteObject,
        signal,
        status: "consumed",
        uploadId: base.id,
      }),
      discardInput({
        context,
        deleteObject: dependencies.deleteObject,
        signal,
        status: "consumed",
        uploadId: target.id,
      }),
    ]);
  };

  if (Result.isError(compared)) {
    await consumeInputs();
    await recordComparisonAudit({ base, changeCount: null, context, target });
    return {
      status: "ok",
      result: {
        status: "upload_failed",
        baseUploadId,
        error: compared.error,
        targetUploadId,
      },
    };
  }

  const delivered = await deliver({
    compared: compared.value,
    context,
    dependencies,
    outputMode,
    signal,
    targetName: target.declaredName,
  });
  await recordComparisonAudit({
    base,
    changeCount: compared.value.changes.length,
    context,
    target,
  });
  if (delivered.status === "error") {
    // The inputs stay staged: the error tells the caller to retry, and the
    // retry has to find them. Their own deadline still expires them.
    return delivered;
  }
  await consumeInputs();

  const scanWarnings = [
    loadedBase.loaded.warnings,
    loadedTarget.loaded.warnings,
  ]
    .filter((warnings): warnings is string[] => warnings !== null)
    .flat();
  const { delivery } = delivered;
  return {
    status: "ok",
    result:
      delivery === null
        ? {
            status: "upload_previewed",
            baseUploadId,
            comparison: compared.value,
            scanWarnings,
            targetUploadId,
          }
        : {
            status: "upload_downloadable",
            baseUploadId,
            comparison: compared.value,
            download: delivery.download,
            fileName: delivery.fileName,
            scanWarnings,
            targetUploadId,
          },
  };
};
