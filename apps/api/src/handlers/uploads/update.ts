import { panic, Result } from "better-result";
import type { Err } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";
import type { ApiFileSecurityRejectionDetails } from "@stll/api-contract";
import { sha256Base64ToHex } from "@stll/sha256";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { pendingUploads } from "@/api/db/schema";
import type { PendingUploadFinalizedResult } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { entityUploadRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { finalizeAgentSkill } from "@/api/handlers/uploads/agent-skill";
import { finalizeEntityVersion } from "@/api/handlers/uploads/entity-version";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
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
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import { observeScanFailures } from "@/api/lib/file-scan/scan-upload-handler";
import { storedDocumentBytes } from "@/api/lib/files/stored-document-bytes";
import { LIMITS } from "@/api/lib/limits";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { logger } from "@/api/lib/observability/logger";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { getS3, readS3ObjectBounded } from "@/api/lib/s3";
import type { HeadObjectResult, S3PresignError } from "@/api/lib/s3-presign";
import { headObject, S3ObjectMissingError } from "@/api/lib/s3-presign";
import { finalizeEntityCreate } from "@/api/lib/uploads/entity-create";
import { UPLOAD_FINALIZE_ADMISSION } from "@/api/lib/uploads/finalize-admission";
import { promoteTmpObjectWithUsage } from "@/api/lib/uploads/promote-tmp-object";
import {
  FINALIZE_CLAIM_TIMEOUT_MS,
  legacyTmpUploadKey,
  tmpUploadKey,
  tmpUploadKeys,
  UploadFinalizeError,
} from "@/api/lib/uploads/runtime";

const finalizeParamsSchema = workspaceParams({
  uploadId: resourceIdSchema("pendingUpload"),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason: "Verifies an upload without delivering file content.",
  },
  description:
    "Step 3 of 3 of the file-upload flow: finalize an upload whose bytes have " +
    "already been PUT to the presigned URL from uploads.create. Verifies the " +
    "stored object against the size and checksum the URL was signed for, " +
    "then commits the durable record and returns finalizedResult, which is " +
    "an entity_create (entityId, fileId, fileName, renamed), entity_version " +
    "(entityId, entityVersionId, versionNumber, fileId, fileName), or " +
    "agent_skill (skillId, name, version) shape depending on the purpose the " +
    "upload was created with. Idempotent: replaying it on an already " +
    "finalized upload returns the same result rather than duplicating.",
  // permissions-exempt: the static gate is workspace:read because the
  // resource-appropriate grant depends on the upload's purpose, which
  // authorizeUploadPurpose (uploads/permissions.ts) checks in-handler.
  permissions: uploadRoutePermission,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityUploadRealtimeUpdates,
  access: "write",
  mcp: { type: "capability", reason: "file_transport", consumesServices: true },
  params: finalizeParamsSchema,
} satisfies WorkspaceHandlerConfig;

type ClaimedRow = typeof pendingUploads.$inferSelect;

const UPLOAD_FINALIZE_DEADLINE_PASSED = "Upload finalize deadline passed";

const fileSecurityRejectionDetails = (
  error: UploadFinalizeError,
): ApiFileSecurityRejectionDetails | null => {
  if (
    error.code !== API_FILE_SECURITY_REJECTED_ERROR_CODE ||
    error.hint === undefined ||
    error.issues === undefined
  ) {
    return null;
  }
  return {
    code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
    hint: error.hint,
    issues: error.issues,
  };
};

type TerminalUploadFields = Pick<
  ClaimedRow,
  "status" | "finalizedResult" | "rejectReason" | "rejectionDetails"
>;

/**
 * The stored response of an upload that already reached a terminal state,
 * or null while it can still be finalized.
 */
const replayTerminalUpload = (
  row: TerminalUploadFields,
): Result<
  { finalizedResult: PendingUploadFinalizedResult },
  HandlerError
> | null => {
  if (row.status === "finalized" && row.finalizedResult) {
    return Result.ok({ finalizedResult: row.finalizedResult });
  }
  if (row.status === "rejected") {
    return Result.err(
      new HandlerError({
        status: 422,
        message: row.rejectReason ?? "Upload was previously rejected",
        ...row.rejectionDetails,
      }),
    );
  }
  return null;
};

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
          columns: {
            purpose: true,
            declaredSize: true,
            status: true,
            finalizedResult: true,
            rejectReason: true,
            rejectionDetails: true,
          },
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
    // A finished upload answers with its stored result at once; only work
    // that still has to read the file waits for capacity.
    const replay = replayTerminalUpload(pending);
    if (replay !== null) {
      return replay;
    }

    // The staged file is read, scanned and may be rewritten in memory, so
    // concurrent finalizations share one byte budget per process. Admission
    // comes before the claim: waiting for capacity never runs the reclaim
    // clock, and a request that is not admitted in time leaves the row as it
    // was, so the retry can claim it at once.
    const release = await UPLOAD_FINALIZE_ADMISSION.acquire(
      pending.declaredSize,
      LIMITS.uploadFinalizeAdmissionWaitMs,
    );
    if (release === null) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Upload processing is busy; retry shortly",
        }),
      );
    }
    try {
      logger.info("uploads.finalize_admitted", {
        declaredBytes: pending.declaredSize,
        inFlightBytes: UPLOAD_FINALIZE_ADMISSION.inUseBytes(),
      });
      return yield* claimAndFinalize({
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        memberRole,
        uploadId,
        safeDb,
        recordAuditEvent,
      });
    } finally {
      release();
    }
  },
);

type ClaimAndFinalizeProps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  uploadId: SafeId<"pendingUpload">;
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
};

/**
 * Claims the upload for this request, runs the finalization and records
 * how it ended. The caller holds finalize admission for the whole call.
 *
 * @yields SafeDb errors out to the safe-handler runner.
 */
const claimAndFinalize = async function* ({
  organizationId,
  workspaceId,
  userId,
  memberRole,
  uploadId,
  safeDb,
  recordAuditEvent,
}: ClaimAndFinalizeProps): AsyncGenerator<
  Err<never, SafeDbError>,
  Result<{ finalizedResult: PendingUploadFinalizedResult }, HandlerError>,
  unknown
> {
  // 1. Claim — atomic transition into `scanning`. Re-claimable
  //    if a previous holder either died (status='scanning' AND
  //    claimed_at older than the timeout) or hit a transient
  //    error (status='failed' AND past the cool-down).
  const timeoutSec = Math.floor(FINALIZE_CLAIM_TIMEOUT_MS / 1000);
  const claimRequestId = Bun.randomUUIDv7().slice(0, 64);
  const claimedRows = yield* Result.await(
    safeDb((tx) =>
      // audit: skip — claim FSM state transition on pending_uploads; ephemeral bookkeeping. The audit row for the resulting entity is emitted by `finalizeEntityCreate` inside the same domain transaction.
      tx
        .update(pendingUploads)
        .set({
          status: "scanning",
          claimedAt: new Date(),
          claimedByRequestId: claimRequestId,
        })
        .where(
          sql`${pendingUploads.id} = ${uploadId}
            AND ${pendingUploads.workspaceId} = ${workspaceId}
            AND ${pendingUploads.userId} = ${userId}
            AND ${pendingUploads.expiresAt} > NOW()
            AND (
              ${pendingUploads.status} = 'pending'
              OR (
                ${pendingUploads.status} IN ('failed', 'scanning')
                AND ${pendingUploads.claimedAt} < NOW() - ${timeoutSec} * interval '1 second'
              )
            )`,
        )
        .returning(),
    ),
  );
  const claimed = claimedRows.at(0);

  if (!claimed) {
    // Claim missed: look up the row and replay or refuse.
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.pendingUploads.findFirst({
          where: {
            id: { eq: uploadId },
            userId: { eq: userId },
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
    const replay = replayTerminalUpload(existing);
    if (replay !== null) {
      return replay;
    }
    const expiredRows = yield* Result.await(
      safeDb((tx) =>
        // audit: skip — expiry transition on pending_uploads; the upload never became a durable entity.
        tx
          .update(pendingUploads)
          .set({
            status: "rejected",
            rejectReason: UPLOAD_FINALIZE_DEADLINE_PASSED,
            finalizedAt: new Date(),
          })
          .where(
            sql`${pendingUploads.id} = ${uploadId}
              AND ${pendingUploads.workspaceId} = ${workspaceId}
              AND ${pendingUploads.userId} = ${userId}
              AND ${pendingUploads.expiresAt} <= NOW()
              AND (
                ${pendingUploads.status} IN ('pending', 'failed')
                OR (
                  ${pendingUploads.status} = 'scanning'
                  AND ${pendingUploads.claimedAt} < NOW() - ${timeoutSec} * interval '1 second'
                )
              )`,
          )
          .returning({ id: pendingUploads.id }),
      ),
    );
    if (expiredRows.at(0)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: UPLOAD_FINALIZE_DEADLINE_PASSED,
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
    organizationId,
    workspaceId,
    userId,
    memberRole,
    uploadId,
    claimRequestId,
    safeDb,
    recordAuditEvent,
  });

  if (Result.isError(finalizeResult)) {
    const error = finalizeResult.error;
    const terminalStatus = error.status === 500 ? "failed" : "rejected";
    const failedRows = yield* Result.await(
      safeDb((tx) =>
        // audit: skip — terminal-state write on pending_uploads, no domain entity to attribute.
        tx
          .update(pendingUploads)
          .set({
            status: terminalStatus,
            rejectReason: error.rejectReason ?? error.message,
            rejectionDetails:
              terminalStatus === "rejected"
                ? fileSecurityRejectionDetails(error)
                : null,
            finalizedAt: terminalStatus === "rejected" ? new Date() : null,
          })
          .where(
            and(
              eq(pendingUploads.id, uploadId),
              eq(pendingUploads.userId, userId),
              eq(pendingUploads.workspaceId, workspaceId),
              eq(pendingUploads.status, "scanning"),
              eq(pendingUploads.claimedByRequestId, claimRequestId),
            ),
          )
          .returning({ id: pendingUploads.id }),
      ),
    );
    if (!failedRows.at(0)) {
      panic("Pending upload failure marker update returned no rows");
    }
    if (terminalStatus === "rejected") {
      // Best-effort tmp cleanup only for terminal rejections.
      // Transient failures keep tmp bytes so finalize can retry.
      await deleteStagedUploadObjects({
        organizationId,
        uploadId,
        workspaceId,
        stage: "tmp-cleanup-after-reject",
      });
    }
    return Result.err(
      new HandlerError({
        status: error.status,
        message: error.message,
        code: error.code,
        hint: error.hint,
        issues: error.issues,
      }),
    );
  }

  return Result.ok({
    finalizedResult: finalizeResult.value.finalizedResult,
  });
};

type RunFinalizeProps = {
  claimed: ClaimedRow;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  uploadId: SafeId<"pendingUpload">;
  claimRequestId: string;
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
};

type RunFinalizeOk = {
  finalizedResult: PendingUploadFinalizedResult;
};

type StagedUploadKeyProps = {
  organizationId: SafeId<"organization">;
  uploadId: SafeId<"pendingUpload">;
  workspaceId: SafeId<"workspace">;
};

type StagedUploadObject = {
  head: HeadObjectResult;
  tmpKey: string;
};

/**
 * The staged object under its scoped key, else under the legacy key. Absent
 * only when the store confirms both keys are empty: a store that failed to
 * answer for either key leaves the question open.
 */
const resolveStagedUploadObject = async ({
  organizationId,
  uploadId,
  workspaceId,
}: StagedUploadKeyProps): Promise<
  Result<StagedUploadObject, S3ObjectMissingError | S3PresignError>
> => {
  const scopedTmpKey = tmpUploadKey({ organizationId, uploadId, workspaceId });
  const scopedHead = await headObject(scopedTmpKey);
  if (Result.isOk(scopedHead)) {
    return Result.ok({ head: scopedHead.value, tmpKey: scopedTmpKey });
  }
  if (!S3ObjectMissingError.is(scopedHead.error)) {
    return Result.err(scopedHead.error);
  }

  const legacyTmpKey = legacyTmpUploadKey(uploadId);
  const legacyHead = await headObject(legacyTmpKey);
  if (Result.isOk(legacyHead)) {
    return Result.ok({ head: legacyHead.value, tmpKey: legacyTmpKey });
  }
  return Result.err(legacyHead.error);
};

const deleteStagedUploadObjects = async ({
  organizationId,
  stage,
  uploadId,
  workspaceId,
}: StagedUploadKeyProps & { stage: "tmp-cleanup-after-reject" }) => {
  for (const key of tmpUploadKeys({ organizationId, uploadId, workspaceId })) {
    await getS3()
      .delete(key)
      .catch((deleteError: unknown) =>
        captureError(
          deleteError,
          handlerErrorContext(`uploads.cleanup.${stage}`, {
            key,
            stage,
            uploadId,
          }),
        ),
      );
  }
};

const observePostPromotion = async (
  afterPromote: () => void,
  uploadId: SafeId<"pendingUpload">,
) => {
  const postPromoteResult = await Result.tryPromise(async () => {
    afterPromote();
    await Promise.resolve();
  });
  if (Result.isError(postPromoteResult)) {
    captureError(
      postPromoteResult.error,
      handlerErrorContext("uploads.runFinalize.postPromoteResult_error", {
        uploadId,
        stage: "post-promote",
      }),
    );
  }
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
  claimRequestId,
  safeDb,
  recordAuditEvent,
}: RunFinalizeProps): AsyncGenerator<
  Err<never, SafeDbError>,
  Result<RunFinalizeOk, UploadFinalizeError>,
  unknown
> {
  // 2. S3 HEAD — exists? size matches? checksum matches?
  const stagedObject = await resolveStagedUploadObject({
    organizationId,
    uploadId: claimed.id,
    workspaceId,
  });
  if (Result.isError(stagedObject)) {
    // Only a confirmed absence is terminal. Any other storage failure keeps
    // the row retryable (status 500 marks it `failed`) and the staged bytes
    // in place, so the next finalize after the claim cool-down reads them.
    return Result.err(
      S3ObjectMissingError.is(stagedObject.error)
        ? new UploadFinalizeError({
            status: 404,
            message: "Upload not found in staging",
            rejectReason: "tmp-missing",
          })
        : new UploadFinalizeError({
            status: 500,
            message: "Upload storage is unavailable; retry shortly",
            rejectReason: "tmp-head-failed",
          }),
    );
  }
  const { head, tmpKey } = stagedObject.value;
  if (head.contentLength !== claimed.declaredSize) {
    return Result.err(
      new UploadFinalizeError({
        status: 422,
        message: `Uploaded size ${head.contentLength} does not match declared ${claimed.declaredSize}`,
        rejectReason: "size-mismatch",
      }),
    );
  }
  if (
    head.checksumSHA256 &&
    sha256Base64ToHex(head.checksumSHA256) !== claimed.declaredSha256
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
  const uploadBytes = await readS3ObjectBounded({
    bucket: envBase.S3_BUCKET,
    key: tmpKey,
    maxBytes: claimed.declaredSize,
    signal: AbortSignal.timeout(FINALIZE_CLAIM_TIMEOUT_MS),
  });
  if (!head.checksumSHA256) {
    const uploadedSha256 = hashSha256Hex(uploadBytes);
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
  const scanResult = await scanUpload({
    bytes: uploadBytes,
    ownership: "transfer",
    declaredMimeType: claimed.declaredMime,
    fileName: claimed.declaredName,
  });
  if (Result.isError(scanResult)) {
    const scanError = scanResult.error;
    observeScanFailures(scanError);
    return Result.err(
      FileScanRejectedError.is(scanError)
        ? new UploadFinalizeError({
            ...scanError.rejection,
            status: 422,
            rejectReason: scanError.rejection.message,
          })
        : new UploadFinalizeError({
            status: 500,
            message: "File security scan failed",
            rejectReason: "scan-error",
          }),
    );
  }
  const scanned = scanResult.value;
  const fileBuffer = scanned.bytes;
  const scanWarnings = scanned.scanWarnings ?? undefined;

  // 4b. Reference removal, after the scan judged what the client actually
  //     sent. Every presigned purpose promotes through the same object and
  //     records the same size and hash, so this is where a stamped download
  //     coming back stops being version N's bytes carrying version N-1's code.
  const { bytes: storedBytes, strippedArchive } =
    await storedDocumentBytes(fileBuffer);
  const storedSha256Hex =
    strippedArchive === null
      ? claimed.declaredSha256
      : hashSha256Hex(storedBytes);

  // A server-side copy is the cheap promotion, but it would publish the bytes
  // the client staged. Stripped bytes exist only here, so they are written.
  const promoteTmpObject = async (finalKey: string) =>
    await promoteTmpObjectWithUsage({
      safeDb,
      workspaceId,
      organizationId,
      tmpKey,
      finalKey,
      storedBytes,
      declaredMime: claimed.declaredMime,
      promotion: strippedArchive === null ? "copy" : "write",
    });

  // 5. Purpose finalization. File-backed purposes promote the tmp
  //    object before committing DB rows that reference the final key.
  const purposeData = claimed.purposeData;
  const domainArgs = {
    safeDb,
    recordAuditEvent,
    organizationId,
    workspaceId,
    userId,
    fileBuffer: strippedArchive ?? fileBuffer,
    declaredName: claimed.declaredName,
    declaredMime: claimed.declaredMime,
    declaredSize: storedBytes.byteLength,
    declaredSha256Hex: storedSha256Hex,
    scanWarnings,
    promoteTmpObject,
    uploadId,
    claimRequestId,
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
    purposeOk = yield* finalizeEntityCreate({
      ...domainArgs,
      purposeData,
      scanned,
    });
  } else if (purposeData.type === "entity_version") {
    purposeOk = yield* finalizeEntityVersion({
      ...domainArgs,
      purposeData,
      scanned,
    });
  } else {
    purposeOk = yield* finalizeAgentSkill({
      safeDb,
      recordAuditEvent,
      organizationId,
      userId,
      memberRole,
      scanned,
      uploadId,
      claimRequestId,
      scope: purposeData.scope,
      workspaceId,
    });
  }
  if (purposeOk.status === "error") {
    return Result.err(purposeOk.error);
  }

  const afterPromote = purposeOk.value.afterPromote;
  if (afterPromote) {
    await observePostPromotion(afterPromote, claimed.id);
  }

  // 6. Tmp cleanup. Bucket lifecycle catches anything we miss.
  await getS3()
    .delete(tmpKey)
    .catch((deleteError: unknown) =>
      captureError(
        deleteError,
        handlerErrorContext("uploads.runFinalize.deleteError", {
          uploadId: claimed.id,
          stage: "tmp-cleanup-after-promote",
        }),
      ),
    );

  return Result.ok({ finalizedResult: purposeOk.value.finalizedResult });
};

export default finalizeUpload;
