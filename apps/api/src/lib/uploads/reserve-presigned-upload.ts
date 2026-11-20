import { Result } from "better-result";
import type { Err } from "better-result";

import { sha256HexToBase64 } from "@stll/sha256";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { type PendingUploadPurposeData, pendingUploads } from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveUploadMime } from "@/api/lib/files/utils";
import {
  type PresignedUploadHeaders,
  presignUploadUrl,
} from "@/api/lib/s3-presign";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  checkEntityCreateCapacityForInsert,
  checkEntityCreateTargetForInsert,
  entityCreateWriteErrorMessage,
  type EntityCreateWriteFailureStatus,
} from "@/api/lib/uploads/entity-create";
import {
  PRESIGN_URL_EXPIRY_SECONDS,
  tmpUploadKey,
  uploadTimeline,
} from "@/api/lib/uploads/runtime";

type EntityCreatePurposeDataWithParent = Extract<
  PendingUploadPurposeData,
  { type: "entity_create" }
> & { parentId: SafeId<"entity"> | null };

export type PresignPurposeData =
  | EntityCreatePurposeDataWithParent
  | Exclude<PendingUploadPurposeData, { type: "entity_create" }>;

/** What a client declared about the file it is about to PUT. */
export type DeclaredUploadFile = {
  name: string;
  mimeType: string;
  size: number;
  sha256Hex: string;
};

export type ReservedUpload = {
  uploadId: SafeId<"pendingUpload">;
  url: string;
  expiresAt: string;
  headers: PresignedUploadHeaders;
};

type ReservePresignedUploadProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  purposeData: PresignPurposeData;
  file: DeclaredUploadFile;
};

/**
 * Reserves an upload and mints its presigned PUT URL, signed against the
 * declared size and checksum. The caller has already authorized the
 * purpose; a document reservation still checks the matter's capacity and
 * the target inside the write, as finalize does again.
 *
 * @yields SafeDb errors out to the safe-handler runner.
 */
export const reservePresignedUpload = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  purposeData,
  file,
}: ReservePresignedUploadProps): AsyncGenerator<
  Err<never, SafeDbError>,
  Result<ReservedUpload, HandlerError>,
  unknown
> {
  // Recover a usable MIME type for extensions browsers mistype
  // (e.g. .msg → octet-stream). The client PUTs with the exact
  // headers we sign below, so the resolved type is what reaches S3
  // and the pending-upload row — no client-side normalization.
  const resolvedMime = resolveUploadMime({
    declaredMime: file.mimeType,
    fileName: sanitizeFilenamePreservingExtension(file.name),
  });

  const uploadId = createSafeId<"pendingUpload">();
  const tmpKey = tmpUploadKey({ organizationId, uploadId, workspaceId });
  const now = new Date();
  const { urlExpiresAt, finalizeDeadline } = uploadTimeline(now);

  const presign = await presignUploadUrl({
    userId,
    key: tmpKey,
    expiresIn: PRESIGN_URL_EXPIRY_SECONDS,
    contentType: resolvedMime,
    contentLength: file.size,
    sha256Base64: sha256HexToBase64(file.sha256Hex),
    scope: { organizationId, workspaceId },
    tagAsTemporaryUpload: true,
  });
  if (Result.isError(presign)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to issue upload URL",
        cause: presign.error,
      }),
    );
  }

  type PresignWriteResult =
    { status: "ok" } | { status: EntityCreateWriteFailureStatus };

  // Persist intent. RLS pins the row to this workspace, so even
  // a stolen URL can only be finalized by a request that
  // resolves to the same workspace_ids on the API role.
  const writeResult = yield* Result.await(
    safeDb(async (tx): Promise<PresignWriteResult> => {
      if (purposeData.type === "entity_create") {
        const capacityResult = await checkEntityCreateCapacityForInsert({
          tx,
          workspaceId,
          entityCount: 1,
        });
        if (Result.isError(capacityResult)) {
          return { status: capacityResult.error };
        }

        const targetResult = await checkEntityCreateTargetForInsert({
          tx,
          workspaceId,
          propertyId: purposeData.propertyId,
          parentId: purposeData.parentId ?? null,
        });
        if (Result.isError(targetResult)) {
          return { status: targetResult.error };
        }
      }

      // audit: skip — presigned URL bookkeeping; the audit row is
      // emitted by the per-purpose finalize once the upload
      // becomes a durable entity.
      await tx.insert(pendingUploads).values({
        id: uploadId,
        organizationId,
        workspaceId,
        userId,
        purpose: purposeData.type,
        purposeData,
        declaredName: file.name,
        declaredMime: resolvedMime,
        declaredSize: file.size,
        declaredSha256: file.sha256Hex,
        status: "pending",
        expiresAt: finalizeDeadline,
        createdAt: now,
      });

      return { status: "ok" };
    }),
  );
  if (writeResult.status !== "ok") {
    return Result.err(
      new HandlerError({
        code:
          writeResult.status === "entities-limit-reached"
            ? "upload_matter_entity_limit_reached"
            : "upload_target_invalid",
        status: 400,
        message: entityCreateWriteErrorMessage(writeResult.status),
      }),
    );
  }

  return Result.ok({
    uploadId,
    url: presign.value.url,
    expiresAt: urlExpiresAt.toISOString(),
    headers: presign.value.headers,
  });
};
