/**
 * Shared types and helpers for the presigned-upload migration
 * (issue #184). Each upload surface (entity create, entity version,
 * agent skills, chat attachments) plugs its own purpose-specific
 * validation into `presignUpload` and its own domain-transaction
 * callback into `runFinalize`; everything else (S3 staging area,
 * claim FSM, head verification, scan, server-side copy, status
 * bookkeeping) is identical and lives here.
 */
import { Result, TaggedError } from "better-result";
import { and, eq } from "drizzle-orm";

import { DOCUMENT_UPLOAD_POLICY } from "@stll/api-contract";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { pendingUploads } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * S3 lifetime of the issued URL and the matching pending-upload reservation.
 * The URL is scoped to the organization/workspace and exact size/checksum;
 * this window covers the slowest supported maximum-size transfer.
 */
export const PRESIGN_URL_EXPIRY_SECONDS =
  DOCUMENT_UPLOAD_POLICY.putTimeoutMs / 1000;

/**
 * Maximum time a `scanning` claim can sit before the next finalize
 * caller is allowed to steal it. Covers the worst-case sync scan
 * (50 MB DOCX through YARA + zip-bomb guard) with headroom. Tuned
 * down once async scanning lands in phase 6.
 */
export const FINALIZE_CLAIM_TIMEOUT_MS = 60_000;

export const UPLOAD_REJECT_REASON = {
  CLIENT_ABORT: "Aborted by client",
  URL_EXPIRED: "Upload URL expired",
} as const;

type RenewFinalizeClaimOptions = {
  claimRequestId: string;
  safeDb: SafeDb;
  uploadId: SafeId<"pendingUpload">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Extend an upload lease immediately before destructive rollback work.
 * A successful renewal prevents a competing finalizer from reclaiming the
 * row while the bounded cleanup runs; a lost or uncertain claim must never
 * delete retry-stable object keys that a newer owner may have published.
 */
export const renewFinalizeClaim = async ({
  claimRequestId,
  safeDb,
  uploadId,
  userId,
  workspaceId,
}: RenewFinalizeClaimOptions): Promise<Result<boolean, SafeDbError>> =>
  await safeDb(async (tx) => {
    const renewed = await tx
      .update(pendingUploads)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(pendingUploads.id, uploadId),
          eq(pendingUploads.userId, userId),
          eq(pendingUploads.workspaceId, workspaceId),
          eq(pendingUploads.status, "scanning"),
          eq(pendingUploads.claimedByRequestId, claimRequestId),
        ),
      )
      .returning({ id: pendingUploads.id });
    return renewed.at(0) !== undefined;
  });

type TmpUploadKeyProps = {
  organizationId: SafeId<"organization">;
  uploadId: SafeId<"pendingUpload">;
  workspaceId: SafeId<"workspace">;
};

/**
 * New presigned uploads stage under the same organization/workspace prefix
 * as durable file objects, so scoped STS credentials can sign the URL.
 */
export const tmpUploadKey = ({
  organizationId,
  uploadId,
  workspaceId,
}: TmpUploadKeyProps): string =>
  `${organizationId}/${workspaceId}/tmp/${uploadId}`;

/** Pre-scoped-signing staging key. Kept only for pending upload migration. */
export const legacyTmpUploadKey = (uploadId: SafeId<"pendingUpload">): string =>
  `tmp/${uploadId}`;

export const tmpUploadKeys = (props: TmpUploadKeyProps): string[] => [
  tmpUploadKey(props),
  legacyTmpUploadKey(props.uploadId),
];

/** Convert lowercase hex SHA-256 to base64 (S3's checksum API expects base64). */
export const sha256HexToBase64 = (hex: string): string =>
  Buffer.from(hex, "hex").toString("base64");

/** Convert base64 SHA-256 (as returned by S3 HEAD) to lowercase hex. */
export const sha256Base64ToHex = (base64: string): string =>
  Buffer.from(base64, "base64").toString("hex");

export class UploadFinalizeError extends TaggedError("UploadFinalizeError")<{
  status: 400 | 404 | 409 | 422 | 500;
  message: string;
  /** Optional reason persisted on the pending_uploads row. */
  rejectReason?: string;
}> {}

/**
 * Re-export of the better-result helper for cases where a non-OK
 * value still represents a logically completed finalize (e.g.
 * idempotent replay returning the cached result). Callers narrow
 * on `status` to know which branch to take.
 */
export const finalizeOk = <T>(value: T): Result<T, UploadFinalizeError> =>
  Result.ok(value);

export const finalizeErr = (
  error: ConstructorParameters<typeof UploadFinalizeError>[0],
): Result<never, UploadFinalizeError> =>
  Result.err(new UploadFinalizeError(error));
