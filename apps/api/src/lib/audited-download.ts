import type { Transaction } from "@/api/db";
import type { AuditRecorder, AuditResourceType } from "@/api/lib/audit-log";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { getS3, presignDownloadUrl } from "@/api/lib/s3";

type AuditedPresignDownloadOptions = {
  tx: Transaction;
  recordAuditEvent: AuditRecorder;
  resourceType: AuditResourceType;
  resourceId: string;
  s3Key: string;
  expiresInSeconds: number;
  /**
   * When set, the returned URL forces a download with this filename
   * via RFC 6266 content-disposition. Omit for inline (in-browser)
   * delivery — but note: inline delivery of privileged content is
   * still a "download" event from the audit point of view; the
   * recorded metadata includes `disposition` so reviewers can
   * distinguish later.
   */
  fileName?: string;
  /** Additional audit metadata (e.g., sizeBytes, contentType). */
  metadata?: Record<string, unknown>;
  workspaceId?: SafeId<"workspace"> | null;
};

/**
 * Single choke point for granting an S3 download URL to a user.
 * Records a DOWNLOAD audit row in the supplied transaction, then
 * returns the presigned URL. The audit row commits with the
 * surrounding work — if the tx rolls back, the audit row does too.
 *
 * Use this for every user-facing download path. Internal proxies
 * that pre-fetch S3 objects server-side (e.g., zip archive
 * assembly) do not call this helper — they audit once at the
 * outer request boundary instead.
 */
export const auditedPresignDownload = async ({
  tx,
  recordAuditEvent,
  resourceType,
  resourceId,
  s3Key,
  expiresInSeconds,
  fileName,
  metadata,
  workspaceId,
}: AuditedPresignDownloadOptions): Promise<string> => {
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.DOWNLOAD,
    resourceType,
    resourceId,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    metadata: {
      s3Key,
      expiresInSeconds,
      disposition: fileName ? "attachment" : "inline",
      ...(fileName ? { fileName } : {}),
      ...metadata,
    },
  });

  if (fileName) {
    return presignDownloadUrl(s3Key, {
      expiresIn: expiresInSeconds,
      fileName,
    });
  }

  return getS3().presign(s3Key, { expiresIn: expiresInSeconds });
};
