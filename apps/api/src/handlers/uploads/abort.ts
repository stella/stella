/**
 * Mark a pending upload as `rejected` so its `tmp/` slot stops
 * counting against the user's intent and so a later finalize call
 * returns the cached reason rather than re-running the FSM.
 * Best-effort tmp delete on top; the bucket lifecycle catches
 * anything we miss.
 *
 * Idempotent for clients: re-aborting an already-aborted row
 * returns 200, not 409. Aborting after finalize commits returns
 * 409 because at that point the bytes are part of the workspace
 * and "aborting" no longer has a meaning.
 */
import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { pendingUploads } from "@/api/db/schema";
import { tmpUploadKey } from "@/api/handlers/uploads/lib";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

const abortParamsSchema = t.Object({
  workspaceId: tSafeId("workspace"),
  uploadId: tSafeId("pendingUpload"),
});

const config = {
  permissions: uploadRoutePermission,
  params: abortParamsSchema,
} satisfies HandlerConfig;

const abortUpload = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, memberRole, params }) {
    const uploadId = params.uploadId;

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.pendingUploads.findFirst({
          where: {
            id: { eq: uploadId },
            userId: { eq: user.id },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );
    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Upload not found" }),
      );
    }
    const authorization = authorizeUploadPurpose({
      memberRole,
      purpose: existing.purpose,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }
    if (existing.status === "finalized") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Upload already finalized — use entity delete instead",
        }),
      );
    }
    if (existing.status === "rejected") {
      return Result.ok({ ok: true as const });
    }

    const abortedRows = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — pending_uploads bookkeeping; the row never
        // became a durable entity, so there's nothing for the audit
        // log to attribute it to.
        return tx
          .update(pendingUploads)
          .set({
            status: "rejected",
            rejectReason: "Aborted by client",
            finalizedAt: new Date(),
          })
          .where(
            and(
              eq(pendingUploads.id, uploadId),
              eq(pendingUploads.userId, user.id),
              eq(pendingUploads.workspaceId, workspaceId),
              inArray(pendingUploads.status, ["pending", "failed"]),
            ),
          )
          .returning({ id: pendingUploads.id });
      }),
    );
    if (!abortedRows.at(0)) {
      const latest = yield* Result.await(
        safeDb((tx) =>
          tx.query.pendingUploads.findFirst({
            where: {
              id: { eq: uploadId },
              userId: { eq: user.id },
              workspaceId: { eq: workspaceId },
            },
            columns: { status: true },
          }),
        ),
      );
      if (!latest) {
        return Result.err(
          new HandlerError({ status: 404, message: "Upload not found" }),
        );
      }
      if (latest.status === "rejected") {
        return Result.ok({ ok: true as const });
      }
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            latest.status === "finalized"
              ? "Upload already finalized — use entity delete instead"
              : "Finalize already in progress for this upload",
        }),
      );
    }

    // Best-effort tmp cleanup. The client may have never actually
    // PUT (so the object never existed) — `delete` on a missing key
    // is a no-op on S3 / MinIO.
    await getS3()
      .delete(tmpUploadKey(uploadId))
      .catch((error: unknown) =>
        captureError(error, { uploadId, stage: "tmp-cleanup-after-abort" }),
      );

    return Result.ok({ ok: true as const });
  },
);

export default abortUpload;
