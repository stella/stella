/**
 * Hand one redline back as a temporary file rather than storing it.
 *
 * Both comparison sources end here when the caller asked for `download`: the
 * staged-upload run, which has no document to save into, and the stored-version
 * comparison, whose caller wants the bytes without a new version. Nothing
 * written here becomes matter content. The row is inserted before the object so
 * the key always has a name, which is what the expiry sweep and the
 * organization storage census both read.
 */

import { Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { fileComparisonUploads } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { FILE_READ_URL_EXPIRY_SECONDS } from "@/api/lib/files/read-file";
import { putTemporaryS3ObjectWithSignal } from "@/api/lib/s3";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import {
  FILE_COMPARISON_REDLINE_TTL_SECONDS,
  fileComparisonExpiry,
  fileComparisonObjectKey,
} from "@/api/lib/uploads/file-comparison/uploads";
import { withTimeout } from "@/api/lib/with-timeout";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * How long the object write has. It matches the comparison's own budget: the
 * bytes are already in memory, so a write that outlives the comparison that
 * produced them is a stalled store rather than a large document.
 */
const REDLINE_WRITE_TIMEOUT_MS = 60_000;

/** Where a delivery gave up. Each step has its own message below. */
const TEMPORARY_REDLINE_FAILURE_STEPS = ["store", "link"] as const;

export type TemporaryRedlineFailureStep =
  (typeof TEMPORARY_REDLINE_FAILURE_STEPS)[number];

export type TemporaryRedlineFailure = {
  cause: unknown;
  step: TemporaryRedlineFailureStep;
};

export const TEMPORARY_REDLINE_FAILURE_MESSAGE = {
  store: "The redline could not be stored",
  link: "The redline's download link could not be prepared",
} as const satisfies Record<TemporaryRedlineFailureStep, string>;

export type TemporaryRedlineDelivery = {
  downloadUrl: string;
  expiresAt: string;
};

export type DeliverTemporaryRedlineOptions = {
  bytes: Uint8Array;
  fileName: string;
  organizationId: SafeId<"organization">;
  /** Sets `app.user_id` and `app.organization_id`, which the row's RLS policy pins. */
  scopedDb: ScopedDb;
  signal: AbortSignal;
  userId: SafeId<"user">;
};

export type DeliverTemporaryRedlineDependencies = {
  presignDownloadUrl: typeof presignDownloadUrl;
  putObject: typeof putTemporaryS3ObjectWithSignal;
};

export const DEFAULT_DELIVER_TEMPORARY_REDLINE_DEPENDENCIES: DeliverTemporaryRedlineDependencies =
  {
    presignDownloadUrl,
    putObject: putTemporaryS3ObjectWithSignal,
  };

export const deliverTemporaryRedline = async (
  {
    bytes,
    fileName,
    organizationId,
    scopedDb,
    signal,
    userId,
  }: DeliverTemporaryRedlineOptions,
  dependencies: DeliverTemporaryRedlineDependencies = DEFAULT_DELIVER_TEMPORARY_REDLINE_DEPENDENCIES,
): Promise<Result<TemporaryRedlineDelivery, TemporaryRedlineFailure>> => {
  const id = createSafeId<"fileComparisonUpload">();
  const key = fileComparisonObjectKey({ organizationId, uploadId: id });
  const expiresAt = fileComparisonExpiry(FILE_COMPARISON_REDLINE_TTL_SECONDS);

  const reserved = await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        // audit: skip — the comparison's own event answers for this object.
        await tx.insert(fileComparisonUploads).values({
          declaredName: fileName,
          declaredSize: bytes.byteLength,
          expiresAt,
          id,
          kind: "redline",
          organizationId,
          status: "ready",
          userId,
        });
      }),
  );
  if (Result.isError(reserved)) {
    return Result.err({ cause: reserved.error, step: "store" });
  }

  const written = await Result.tryPromise(
    async () =>
      await withTimeout(
        async (operationSignal) =>
          await dependencies.putObject(
            key,
            bytes,
            DOCX_MIME_TYPE,
            operationSignal,
          ),
        {
          label: "file-comparison.write",
          signal,
          timeoutMs: REDLINE_WRITE_TIMEOUT_MS,
        },
      ),
  );
  if (Result.isError(written)) {
    return Result.err({ cause: written.error, step: "store" });
  }

  const downloadUrl = await Result.tryPromise(
    async () =>
      await dependencies.presignDownloadUrl(key, {
        expiresIn: FILE_READ_URL_EXPIRY_SECONDS,
        fileName,
        // The key is organization-level `tmp/`, never workspace storage.
        scope: { organizationId, workspaceId: null },
      }),
  );
  if (Result.isError(downloadUrl)) {
    return Result.err({ cause: downloadUrl.error, step: "link" });
  }

  return Result.ok({
    downloadUrl: downloadUrl.value,
    expiresAt: expiresAt.toISOString(),
  });
};
