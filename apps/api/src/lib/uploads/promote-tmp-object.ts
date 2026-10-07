import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  BUFFER_INTENT_DELETE_TIMEOUT_MS,
  cleanupObjectAfterWriter,
  reserveObjectCleanupIntent,
} from "@/api/lib/buffer-intent-reconciliation";
import { deleteOrganizationFileWithSignal } from "@/api/lib/files/delete-organization-file";
import {
  commitOrganizationFileBytes,
  authorizeOrganizationFileWrite,
} from "@/api/lib/files/organization-file-usage";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  S3_OBJECT_WRITE_CERTAINTY,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";
import { copyObject } from "@/api/lib/s3-presign";
import { UploadFinalizeError } from "@/api/lib/uploads/runtime";

const PROMOTION_CLEANUP_FAILURE = failureSink({
  event: "upload.promotion_cleanup_failed",
  expected: [],
});
export type PromotedUploadObject = {
  intentId: SafeId<"pendingUpload">;
  cleanup: () => Promise<void>;
};
type PromoteTmpObjectOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  tmpKey: string;
  finalKey: string;
  storedBytes: Uint8Array;
  declaredMime: string;
  promotion: "copy" | "write";
};

export const promoteTmpObjectWithUsage = async ({
  safeDb,
  workspaceId,
  organizationId,
  tmpKey,
  finalKey,
  storedBytes,
  declaredMime,
  promotion,
}: PromoteTmpObjectOptions): Promise<
  Result<PromotedUploadObject, UploadFinalizeError>
> => {
  const reservedIntent = await reserveObjectCleanupIntent({
    safeDb,
    workspaceId,
    organizationId,
    objectKey: finalKey,
  });
  if (Result.isError(reservedIntent)) {
    return Result.err(
      new UploadFinalizeError({
        status: 500,
        message: "Failed to reserve object cleanup",
        rejectReason: "cleanup-reservation-failed",
      }),
    );
  }
  const intentId = reservedIntent.value;
  let writeState: S3ObjectWriteCertainty | "never-written" = "never-written";
  const cleanup = async () => {
    const cleaned = await cleanupObjectAfterWriter({
      safeDb,
      intentId,
      writeState,
      deleteObject: async () => {
        const deleted = await deleteOrganizationFileWithSignal(
          finalKey,
          AbortSignal.timeout(BUFFER_INTENT_DELETE_TIMEOUT_MS),
        );
        if (Result.isError(deleted)) {
          observeFailure(deleted.error, {
            sink: PROMOTION_CLEANUP_FAILURE,
            ctx: { organizationId },
          });
        }
        return Result.isOk(deleted);
      },
    });
    if (Result.isError(cleaned)) {
      observeFailure(cleaned.error, {
        sink: PROMOTION_CLEANUP_FAILURE,
        ctx: { organizationId },
      });
    }
  };
  let transferred = false;
  try {
    const authorization = await authorizeOrganizationFileWrite({
      organizationId,
      objectKey: finalKey,
      sizeBytes: storedBytes.byteLength,
    });
    if (Result.isError(authorization)) {
      return Result.err(
        new UploadFinalizeError({
          status:
            authorization.error.reason === "capacity_exceeded" ? 409 : 500,
          message: authorization.error.message,
          rejectReason: authorization.error.reason,
        }),
      );
    }
    const outcome = await authorization.value.execute(
      async ({ input: named }) => {
        writeState = S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN;
        // The copy SDK may retry internally without exposing earlier transport outcomes.
        const promoted =
          promotion === "copy"
            ? (await copyObject(tmpKey, finalKey)).map(
                () => S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN,
              )
            : await Result.tryPromise({
                try: async () =>
                  await writeS3ObjectWithRetry(
                    {
                      contentType: declaredMime,
                      data: storedBytes,
                      key: finalKey,
                    },
                    { type: "cleanup-intent", intent: intentId },
                  ),
                catch: (cause) => cause,
              });
        if (Result.isError(promoted)) {
          return Result.err(
            new UploadFinalizeError({
              status: 500,
              message: "Failed to promote tmp object",
              rejectReason:
                promotion === "copy" ? "copy-failed" : "write-failed",
            }),
          );
        }
        writeState = promoted.value;
        const committed = await commitOrganizationFileBytes(
          named.value.reservation,
        );
        if (Result.isError(committed)) {
          return Result.err(
            new UploadFinalizeError({
              status: 500,
              message: committed.error.message,
              rejectReason: "usage-commit-failed",
            }),
          );
        }
        return Result.ok({ intentId, cleanup });
      },
    );
    transferred = Result.isOk(outcome);
    return outcome;
  } finally {
    if (!transferred) {
      await cleanup();
    }
  }
};
