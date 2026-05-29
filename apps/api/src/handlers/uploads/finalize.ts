/**
 * Finalize a presigned upload. Runs the claim FSM, verifies what
 * the client uploaded against what they declared, scans the bytes,
 * dispatches into the per-purpose domain finalizer, then records the
 * finalized result. File-backed finalizers promote `tmp/` to the final
 * key before committing DB rows that point at it.
 *
 * Concurrency-safe via an atomic `UPDATE … WHERE status IN (…)`
 * claim. A second caller for the same `uploadId` either:
 *   - replays the cached `finalizedResult` (status = 'finalized')
 *   - sees the cached reject reason  (status = 'rejected')
 *   - gets a 409 if a previous attempt is still inside its
 *     `FINALIZE_CLAIM_TIMEOUT_MS` window
 *
 * Crash recovery is implicit: a process that dies mid-scan leaves
 * the row in `scanning`; the next finalize call after the timeout
 * can re-claim it because both `claimed_at` and the row's status
 * are atomically compared in the WHERE.
 */
import { Result, panic } from "better-result";
import type { Err } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb, SafeDbError } from "@/api/db";
import { pendingUploads } from "@/api/db/schema";
import type { PendingUploadFinalizedResult } from "@/api/db/schema";
import { finalizeAgentSkill } from "@/api/handlers/uploads/agent-skill";
import { finalizeEntityCreate } from "@/api/handlers/uploads/entity-create";
import { finalizeEntityVersion } from "@/api/handlers/uploads/entity-version";
import {
  FINALIZE_CLAIM_TIMEOUT_MS,
  sha256Base64ToHex,
  tmpUploadKey,
  UploadFinalizeError,
} from "@/api/handlers/uploads/lib";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanFile } from "@/api/lib/file-scan/scan";
import { getS3 } from "@/api/lib/s3";
import { copyObject, headObject } from "@/api/lib/s3-presign";

const finalizeParamsSchema = t.Object({
  workspaceId: tSafeId("workspace"),
  uploadId: tSafeId("pendingUpload"),
});

const config = {
  permissions: uploadRoutePermission,
  params: finalizeParamsSchema,
} satisfies HandlerConfig;

type ClaimedRow = typeof pendingUploads.$inferSelect;

const finalizeUpload = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    memberRole,
    params,
    recordAuditEvent,
  }) {
    const uploadId = params.uploadId;

    const pending = yield* Result.await(
      safeDb((tx) =>
        tx.query.pendingUploads.findFirst({
          where: {
            id: { eq: uploadId },
            userId: { eq: user.id },
            workspaceId: { eq: workspaceId },
          },
          columns: { purpose: true },
        }),
      ),
    );
    if (!pending) {
      return Result.err(
        new HandlerError({ status: 404, message: "Upload not found" }),
      );
    }
    const authorization = authorizeUploadPurpose({
      memberRole,
      purpose: pending.purpose,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

    // 1. Claim — atomic transition into `scanning`. Re-claimable
    //    if a previous holder either died (status='scanning' AND
    //    claimed_at older than the timeout) or hit a transient
    //    error (status='failed' AND past the cool-down).
    const timeoutSec = Math.floor(FINALIZE_CLAIM_TIMEOUT_MS / 1000);
    const claimedRows = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — claim FSM state transition on
        // pending_uploads; ephemeral bookkeeping. The audit row for
        // the resulting entity is emitted by `finalizeEntityCreate`
        // inside the same domain transaction.
        return tx
          .update(pendingUploads)
          .set({
            status: "scanning",
            claimedAt: new Date(),
            claimedByRequestId: Bun.randomUUIDv7().slice(0, 64),
          })
          .where(
            sql`${pendingUploads.id} = ${uploadId}
              AND ${pendingUploads.workspaceId} = ${workspaceId}
              AND ${pendingUploads.userId} = ${user.id}
              AND (
                ${pendingUploads.status} = 'pending'
                OR (
                  ${pendingUploads.status} IN ('failed', 'scanning')
                  AND ${pendingUploads.claimedAt} < NOW() - ${timeoutSec} * interval '1 second'
                )
              )`,
          )
          .returning();
      }),
    );
    const claimed = claimedRows.at(0);

    if (!claimed) {
      // Claim missed: look up the row and replay or refuse.
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
      if (existing.status === "finalized" && existing.finalizedResult) {
        return Result.ok({ finalizedResult: existing.finalizedResult });
      }
      if (existing.status === "rejected") {
        return Result.err(
          new HandlerError({
            status: 422,
            message: existing.rejectReason ?? "Upload was previously rejected",
          }),
        );
      }
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Finalize already in progress for this upload",
        }),
      );
    }

    // From here on we own the row. Any early return must transition
    // the row to a terminal status; `scanning` left behind would
    // block re-claim until the timeout.
    const finalizeResult = yield* runFinalize({
      claimed,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      memberRole,
      uploadId,
      safeDb,
      recordAuditEvent,
    });

    if (Result.isError(finalizeResult)) {
      const error = finalizeResult.error;
      const terminalStatus = error.status === 500 ? "failed" : "rejected";
      const failedRows = yield* Result.await(
        // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
        safeDb((tx) => {
          // audit: skip — terminal-state write on pending_uploads,
          // no domain entity to attribute.
          return tx
            .update(pendingUploads)
            .set({
              status: terminalStatus,
              rejectReason: error.rejectReason ?? error.message,
              finalizedAt: terminalStatus === "rejected" ? new Date() : null,
            })
            .where(
              and(
                eq(pendingUploads.id, uploadId),
                eq(pendingUploads.userId, user.id),
                eq(pendingUploads.workspaceId, workspaceId),
              ),
            )
            .returning({ id: pendingUploads.id });
        }),
      );
      if (!failedRows.at(0)) {
        panic("Pending upload failure marker update returned no rows");
      }
      if (terminalStatus === "rejected") {
        // Best-effort tmp cleanup only for terminal rejections.
        // Transient failures keep tmp bytes so finalize can retry.
        await getS3()
          .delete(tmpUploadKey(uploadId))
          .catch((deleteError: unknown) =>
            captureError(deleteError, {
              uploadId,
              stage: "tmp-cleanup-after-reject",
            }),
          );
      }
      return Result.err(
        new HandlerError({ status: error.status, message: error.message }),
      );
    }

    return Result.ok({ finalizedResult: finalizeResult.value.finalizedResult });
  },
);

type RunFinalizeProps = {
  claimed: ClaimedRow;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  memberRole: { role: string };
  uploadId: SafeId<"pendingUpload">;
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
};

type RunFinalizeOk = {
  finalizedResult: PendingUploadFinalizedResult;
};

/**
 * Generic finalize body. Verifies what S3 has against what the
 * pending row says, scans the bytes, dispatches into the
 * per-purpose domain finalizer, then removes the tmp object after the
 * purpose has durably accepted the upload.
 *
 * @yields SafeDb errors out to the safe-handler runner so the only
 *   errors that escape are the typed `UploadFinalizeError` cases.
 */
const runFinalize = async function* ({
  claimed,
  organizationId,
  workspaceId,
  userId,
  memberRole,
  uploadId,
  safeDb,
  recordAuditEvent,
}: RunFinalizeProps): AsyncGenerator<
  Err<never, SafeDbError>,
  Result<RunFinalizeOk, UploadFinalizeError>,
  unknown
> {
  const tmpKey = tmpUploadKey(claimed.id);

  // 2. S3 HEAD — exists? size matches? checksum matches?
  const head = await headObject(tmpKey);
  if (Result.isError(head)) {
    return Result.err(
      new UploadFinalizeError({
        status: 404,
        message: "Upload not found in staging — URL likely expired",
        rejectReason: "tmp-head-failed",
      }),
    );
  }
  if (head.value.contentLength !== claimed.declaredSize) {
    return Result.err(
      new UploadFinalizeError({
        status: 422,
        message: `Uploaded size ${head.value.contentLength} does not match declared ${claimed.declaredSize}`,
        rejectReason: "size-mismatch",
      }),
    );
  }
  if (
    head.value.checksumSHA256 &&
    sha256Base64ToHex(head.value.checksumSHA256) !== claimed.declaredSha256
  ) {
    return Result.err(
      new UploadFinalizeError({
        status: 422,
        message: "Uploaded SHA-256 does not match declared",
        rejectReason: "sha256-mismatch",
      }),
    );
  }

  // 3. Download for scan.
  const fileBuffer = await getS3().file(tmpKey).arrayBuffer();
  if (!head.value.checksumSHA256) {
    const uploadedSha256 = new Bun.CryptoHasher("sha256")
      .update(fileBuffer)
      .digest("hex");
    if (uploadedSha256 !== claimed.declaredSha256) {
      return Result.err(
        new UploadFinalizeError({
          status: 422,
          message: "Uploaded SHA-256 does not match declared",
          rejectReason: "sha256-mismatch",
        }),
      );
    }
  }

  // 4. Scan — same pipeline the legacy upload handler ran inline.
  const scanResult = await scanFile({
    buffer: new Uint8Array(fileBuffer),
    declaredMimeType: claimed.declaredMime,
    fileName: claimed.declaredName,
  });
  if (Result.isError(scanResult)) {
    return Result.err(
      new UploadFinalizeError({
        status: 500,
        message: "File security scan failed",
        rejectReason: "scan-error",
      }),
    );
  }
  if (scanResult.value.verdict === "reject") {
    const reasons = scanResult.value.findings
      .filter((finding) => finding.severity === "reject")
      .map((finding) => finding.message);
    return Result.err(
      new UploadFinalizeError({
        status: 422,
        message: `File rejected: ${reasons.join("; ")}`,
        rejectReason: reasons.join("; "),
      }),
    );
  }
  const scanWarnings =
    scanResult.value.verdict === "warn"
      ? scanResult.value.findings
          .filter((finding) => finding.severity === "warn")
          .map((finding) => finding.message)
      : undefined;

  const promoteTmpObject = async (finalKey: string) => {
    const copyResult = await copyObject(tmpKey, finalKey);
    if (Result.isError(copyResult)) {
      return Result.err(
        new UploadFinalizeError({
          status: 500,
          message: "Failed to promote tmp object",
          rejectReason: "copy-failed",
        }),
      );
    }
    return Result.ok(undefined);
  };

  // 5. Purpose finalization. File-backed purposes promote the tmp
  //    object before committing DB rows that reference the final key.
  const purposeData = claimed.purposeData;
  const domainArgs = {
    safeDb,
    recordAuditEvent,
    organizationId,
    workspaceId,
    userId,
    fileBuffer,
    declaredName: claimed.declaredName,
    declaredMime: claimed.declaredMime,
    declaredSize: claimed.declaredSize,
    declaredSha256Hex: claimed.declaredSha256,
    scanWarnings,
    promoteTmpObject,
    uploadId,
  };

  // Dispatch on purposeData. Each variant is independent; the
  // `purposeData` field is the source of truth (it carries the
  // discriminator), and the body schemas at presign time guarantee
  // it matches the URL purpose.
  type RunAnyPurpose =
    Awaited<
      ReturnType<
        | typeof finalizeEntityCreate
        | typeof finalizeEntityVersion
        | typeof finalizeAgentSkill
      >
    > extends AsyncGenerator<unknown, infer R, unknown>
      ? R
      : never;
  let purposeOk: RunAnyPurpose;
  if (purposeData.type === "entity_create") {
    purposeOk = yield* finalizeEntityCreate({ ...domainArgs, purposeData });
  } else if (purposeData.type === "entity_version") {
    purposeOk = yield* finalizeEntityVersion({ ...domainArgs, purposeData });
  } else {
    purposeOk = yield* finalizeAgentSkill({
      safeDb,
      recordAuditEvent,
      organizationId,
      userId,
      memberRole,
      fileBuffer,
      declaredName: claimed.declaredName,
      declaredMime: claimed.declaredMime,
      uploadId,
      scope: purposeData.scope,
      workspaceId,
    });
  }
  if (purposeOk.status === "error") {
    return Result.err(purposeOk.error);
  }

  const afterPromote = purposeOk.value.afterPromote;
  if (afterPromote) {
    const postPromoteResult = await Result.tryPromise(async () => {
      afterPromote();
      await Promise.resolve();
    });
    if (Result.isError(postPromoteResult)) {
      captureError(postPromoteResult.error, {
        uploadId: claimed.id,
        stage: "post-promote",
      });
    }
  }

  // 6. Tmp cleanup. Bucket lifecycle catches anything we miss.
  await getS3()
    .delete(tmpKey)
    .catch((deleteError: unknown) =>
      captureError(deleteError, {
        uploadId: claimed.id,
        stage: "tmp-cleanup-after-promote",
      }),
    );

  return Result.ok({ finalizedResult: purposeOk.value.finalizedResult });
};

export default finalizeUpload;
