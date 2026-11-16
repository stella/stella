import type { Transaction } from "@/api/db/root";
import type {
  AuditAction,
  AuditRecorder,
  AuditResourceType,
} from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { recordContentDeliveryReceipt } from "@/api/lib/files/content-delivery";
import type { LiveVersionLock } from "@/api/lib/files/live-version-field";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import type {
  S3SigningKeyspace,
  SignedDownloadSource,
} from "@/api/lib/s3-presign";
import type { SyntheticSessionAuthorityReader } from "@/api/lib/synthetic-principal/session-authority";

export type ContentDisposition = "attachment" | "inline";

/**
 * The audit action for delivering stored content: a saved copy is a download,
 * an in-browser rendering is an access. Every content grant records its action
 * through this map, so the audit log names a view and a download apart.
 */
export const CONTENT_DELIVERY_AUDIT_ACTION = {
  attachment: AUDIT_ACTION.DOWNLOAD,
  inline: AUDIT_ACTION.ACCESS,
} as const satisfies Record<ContentDisposition, AuditAction>;

/**
 * What the grant audits, and the transaction it records in. A document's file
 * belongs to a version that can be tombstoned, so its grant takes the version
 * lock instead of a bare transaction: the audit row and the signature then
 * happen where no tombstone can commit, and the audited entity is the locked
 * one. Every other resource is audited in the caller's transaction.
 */
type AuditedGrantTarget =
  | {
      resourceType: typeof AUDIT_RESOURCE_TYPE.ENTITY;
      versionLock: LiveVersionLock;
    }
  | {
      resourceType: Exclude<
        AuditResourceType,
        typeof AUDIT_RESOURCE_TYPE.ENTITY
      >;
      resourceId: string;
      tx: Transaction;
    };

const grantTransaction = (target: AuditedGrantTarget) =>
  target.resourceType === AUDIT_RESOURCE_TYPE.ENTITY
    ? {
        tx: target.versionLock.version.tx,
        resourceId: target.versionLock.version.entityId,
      }
    : { tx: target.tx, resourceId: target.resourceId };

type AuditedPresignDownloadOptions = AuditedGrantTarget & {
  userId: string | null;
  source: SignedDownloadSource;
  recordAuditEvent: AuditRecorder;
  readSessionAuthority: SyntheticSessionAuthorityReader;
  s3Key: string;
  expiresInSeconds: number;
  /**
   * When set, the returned URL forces a download with this filename
   * via RFC 6266 content-disposition and records a download. Omit for
   * inline (in-browser) delivery, which records an access.
   */
  fileName?: string;
  /** Additional audit metadata (e.g., sizeBytes, contentType). */
  metadata?: Record<string, unknown>;
  organizationId?: SafeId<"organization"> | null;
  s3Keyspace?: S3SigningKeyspace;
  workspaceId?: SafeId<"workspace"> | null;
  signDownload?: typeof presignDownloadUrl;
};

/**
 * Single choke point for granting an S3 download URL to a user.
 * Records a download (attachment) or access (inline) audit row in the
 * supplied transaction, then returns the presigned URL. The audit row commits with the
 * surrounding work — if the tx rolls back, the audit row does too.
 *
 * Use this for every user-facing download path. Internal proxies
 * that pre-fetch S3 objects server-side (e.g., zip archive
 * assembly) do not call this helper — they audit once at the
 * outer request boundary instead.
 */
export const auditedPresignDownload = async (
  options: AuditedPresignDownloadOptions,
): Promise<string> => {
  const {
    userId,
    source,
    recordAuditEvent,
    readSessionAuthority,
    resourceType,
    s3Key,
    expiresInSeconds,
    fileName,
    metadata,
    organizationId,
    s3Keyspace,
    workspaceId,
    signDownload = presignDownloadUrl,
  } = options;
  const { tx, resourceId } = grantTransaction(options);
  const disposition: ContentDisposition = fileName ? "attachment" : "inline";
  await recordAuditEvent(tx, {
    action: CONTENT_DELIVERY_AUDIT_ACTION[disposition],
    resourceType,
    resourceId,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    metadata: {
      s3Key,
      expiresInSeconds,
      disposition,
      ...(fileName ? { fileName } : {}),
      ...metadata,
    },
  });

  recordContentDeliveryReceipt();

  return await signDownload(s3Key, {
    userId,
    expiresIn: expiresInSeconds,
    source,
    readSessionAuthority,
    ...(fileName ? { fileName } : {}),
    ...(organizationId
      ? {
          scope: {
            organizationId,
            workspaceId: workspaceId ?? null,
            ...(s3Keyspace === undefined ? {} : { keyspace: s3Keyspace }),
          },
        }
      : {}),
  });
};
