/**
 * Phase 2 end to end: embed the stored signature and write the signed
 * version, classifying every failure as one a retry can fix or one it
 * cannot. The handler turns the first kind into a 503 that leaves the
 * exchange open and the second into a closed exchange, so no failure leaves
 * an exchange open that nothing can finish.
 */

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import { pdfSigningSessions } from "@/api/db/schema";
import type {
  PdfSigningKeyType,
  PdfSigningSessionCloseReason,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentSource } from "@/api/lib/document-source";
import { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import type { EntityVersionTargetErrorCode } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import { HandlerError, TimeoutError } from "@/api/lib/errors/tagged-errors";
import { loadPdfSigningBaseBytes } from "@/api/lib/files/pdf-signing/base-bytes";
import { chainReachesRoot } from "@/api/lib/files/pdf-signing/certificate-chain";
import type { AuthorizedPdfSigningSession } from "@/api/lib/files/pdf-signing/sessions";
import {
  applySignature,
  PdfSigningCertificateRevokedError,
  PdfSigningDigestMismatchError,
} from "@/api/lib/files/pdf-signing/sign-pdf";
import type { AppliedSignature } from "@/api/lib/files/pdf-signing/sign-pdf";
import { configuredTimestampAuthorities } from "@/api/lib/files/pdf-signing/timestamp-authority";
import { configuredTimestampTrustAnchors } from "@/api/lib/files/pdf-signing/timestamp-trust";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/** What phase 1 stored, all of it present. */
export type PreparedSigningState = {
  digestHex: string;
  keyType: PdfSigningKeyType;
  placeholderSize: number;
  signedAttributes: Uint8Array;
  signerCertificateDer: Uint8Array;
  signingTime: Date;
};

export type FinalizeFailure =
  | { kind: "retryable"; error: HandlerError }
  | {
      kind: "terminal";
      closeReason: PdfSigningSessionCloseReason;
      error: HandlerError;
    };

export const certificateRevokedError = () =>
  new HandlerError({
    status: 422,
    code: "pdf_signing_certificate_revoked",
    message:
      "The signing certificate, or one that issued it, has been revoked.",
  });

export type FinalizedSignature = {
  versionId: SafeId<"entityVersion">;
  versionNumber: number;
};

/** The hint every retryable answer carries; the desktop acts on the 503. */
const RETRY_HINT =
  "The signature is kept. Post it again with the same session token to retry.";

export const retryable = (
  code: string,
  message: string,
  cause?: unknown,
): FinalizeFailure => ({
  kind: "retryable",
  error: new HandlerError({
    status: 503,
    code,
    message,
    hint: RETRY_HINT,
    cause,
  }),
});

const terminal = (
  closeReason: PdfSigningSessionCloseReason,
  error: HandlerError,
): FinalizeFailure => ({ kind: "terminal", closeReason, error });

/**
 * Version-writer rejections, each with the reason the exchange ends for
 * and its status. `null` marks the one a retry can clear: the file is open
 * in a desktop edit session, which the user can close. Total over the
 * writer's codes, so a new rejection reaches a decision here.
 */
const VERSION_WRITE_OUTCOME = {
  "current-version-changed": ["base_version_diverged", 409],
  "current-version-not-found": ["base_version_diverged", 409],
  "document-too-large": ["signing_failed", 413],
  "edit-session-open": null,
  "entity-not-found": ["base_version_diverged", 404],
  "entity-read-only": ["signing_failed", 409],
  "missing-file-field": ["base_version_diverged", 409],
  "source-version-not-found": ["base_version_diverged", 409],
  "target-file-not-found": ["base_version_diverged", 409],
  "workspace-not-active": ["signing_failed", 409],
} as const satisfies Record<
  EntityVersionTargetErrorCode,
  readonly [PdfSigningSessionCloseReason, 404 | 409 | 413] | null
>;

/** The stored issuer chain; `null` until phase 1 has stored one. */
const decodeCertificateChain = (chain: string[] | null) =>
  chain === null
    ? []
    : chain.map((entry) => new Uint8Array(Buffer.from(entry, "base64")));

/** Provenance of the signed version: what was signed, with what, how. */
const signatureSource = ({
  applied,
  baseVersionId,
  prepared,
}: {
  applied: AppliedSignature;
  baseVersionId: string;
  prepared: PreparedSigningState;
}): DocumentSource => ({
  kind: "signature",
  baseVersionId,
  certificateSha256Hex: new Bun.CryptoHasher("sha256")
    .update(prepared.signerCertificateDer)
    .digest("hex"),
  level: applied.level,
  signingTime: prepared.signingTime.toISOString(),
  timestampAuthorityUrl: applied.timestampAuthorityUrl,
  warnings: applied.warnings,
});

type FinalizeOptions = {
  /** The claimed attempt; only it may finalize the exchange. */
  attempt: number;
  prepared: PreparedSigningState;
  recordAuditEvent: AuditRecorder;
  session: AuthorizedPdfSigningSession;
  signature: Uint8Array;
};

const embed = async (
  { prepared, session, signature }: FinalizeOptions,
  basePdf: Uint8Array,
): Promise<Result<AppliedSignature, FinalizeFailure>> => {
  const certificateChain = decodeCertificateChain(
    session.signerCertificateChain,
  );
  const applied = await applySignature({
    basePdf,
    certificate: new Uint8Array(prepared.signerCertificateDer),
    certificateChain,
    certificateChainComplete: chainReachesRoot(
      prepared.signerCertificateDer,
      certificateChain,
    ),
    expectedDigestHex: prepared.digestHex,
    keyType: prepared.keyType,
    location: session.location,
    placeholderSize: prepared.placeholderSize,
    reason: session.reason,
    signature,
    signatureAlgorithm:
      prepared.keyType === "RSA" ? "RSASSA-PKCS1-v1_5" : "ECDSA",
    signingTime: prepared.signingTime,
    stamp: session.stamp,
    timestampAuthorities: configuredTimestampAuthorities(),
    timestampTrustAnchors: configuredTimestampTrustAnchors(),
  });
  if (Result.isOk(applied)) {
    return Result.ok(applied.value);
  }
  const cause = applied.error;
  if (PdfSigningDigestMismatchError.is(cause)) {
    return Result.err(
      terminal(
        "digest_mismatch",
        new HandlerError({
          status: 409,
          code: "pdf_signing_digest_mismatch",
          message:
            "The prepared signature no longer matches this document. Start signing again.",
        }),
      ),
    );
  }
  if (PdfSigningCertificateRevokedError.is(cause)) {
    return Result.err(
      terminal("certificate_revoked", certificateRevokedError()),
    );
  }
  // Embedding is deterministic over the stored inputs except for its time
  // budget: only running out of time is worth another attempt.
  if (TimeoutError.is(cause)) {
    return Result.err(
      retryable(
        "pdf_signing_finalize_unavailable",
        "Signing took too long to finish. Try again.",
        cause,
      ),
    );
  }
  return Result.err(
    terminal(
      "signing_failed",
      new HandlerError({
        status: 422,
        code: "pdf_signing_failed",
        message: "The signature could not be embedded in this PDF.",
        cause,
      }),
    ),
  );
};

/**
 * Store the signed PDF as the new current version and finalize the exchange
 * in the same transaction: an exchange can never be marked finalized without
 * the version it names, nor the reverse.
 */
const writeSignedVersion = async (
  { attempt, prepared, recordAuditEvent, session }: FinalizeOptions,
  applied: AppliedSignature,
  fileName: string,
) =>
  await Result.tryPromise(
    async () =>
      await createEntityVersionFromBuffer({
        buffer: applied.bytes,
        entityId: session.entityId,
        fileName,
        mimeType: PDF_MIME_TYPE,
        organizationId: session.organizationId,
        recordAuditEvent,
        safeDb: session.safeDb,
        source: signatureSource({
          applied,
          baseVersionId: session.baseVersionId,
          prepared,
        }),
        userId: session.userId,
        workspaceId: session.workspaceId,
        writePolicy: {
          type: "pdf-signature",
          expectedCurrentVersionId: session.baseVersionId,
          filePropertyId: session.propertyId,
        },
        afterWrite: async (tx, result) => {
          const finalized = await tx
            .update(pdfSigningSessions)
            .set({
              closedAt: new Date(),
              finalizeLeaseExpiresAt: null,
              finalizedVersionId: result.entityVersionId,
              status: "finalized",
            })
            .where(
              and(
                eq(pdfSigningSessions.id, session.sessionId),
                eq(pdfSigningSessions.status, "open"),
                eq(pdfSigningSessions.finalizeAttempts, attempt),
              ),
            )
            .returning({ id: pdfSigningSessions.id });
          // Cancelled, or superseded by a later attempt after this one's
          // lease lapsed: rolling back takes the version with it, so only
          // the attempt holding the exchange can finalize it.
          if (!finalized.at(0)) {
            tx.rollback();
          }

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
            resourceId: session.sessionId,
            changes: {
              status: { old: "open", new: "finalized" },
              finalizedVersionId: { old: null, new: result.entityVersionId },
            },
            metadata: { level: applied.level },
          });
        },
      }),
  );

export const finalizeSignature = async (
  options: FinalizeOptions,
): Promise<Result<FinalizedSignature, FinalizeFailure>> => {
  const { recordAuditEvent, session } = options;

  // The same read refuses a base the document has moved away from, so the
  // file name is the pinned version's.
  const base = await loadPdfSigningBaseBytes({ recordAuditEvent, session });
  if (Result.isError(base)) {
    return Result.err(
      base.error.status >= 500
        ? retryable(
            "pdf_signing_finalize_unavailable",
            "The document could not be read. Try again.",
            base.error,
          )
        : terminal(
            base.error.code === "pdf_signing_base_version_diverged"
              ? "base_version_diverged"
              : "signing_failed",
            base.error,
          ),
    );
  }

  const applied = await embed(options, base.value.bytes);
  if (Result.isError(applied)) {
    return applied;
  }

  const written = await writeSignedVersion(
    options,
    applied.value,
    base.value.fileName,
  );
  if (Result.isError(written)) {
    return Result.err(
      retryable(
        "pdf_signing_finalize_unavailable",
        "The signed document could not be stored. Try again.",
        written.error,
      ),
    );
  }
  if (Result.isError(written.value)) {
    const rejection = written.value.error;
    const outcome = VERSION_WRITE_OUTCOME[rejection.code];
    return Result.err(
      outcome === null
        ? retryable("pdf_signing_edit_session_open", rejection.message)
        : terminal(
            outcome[0],
            new HandlerError({
              status: outcome[1],
              message: rejection.message,
            }),
          ),
    );
  }

  const version = written.value.value;
  broadcastWorkspaceResourceUpdated(
    session.workspaceId,
    resourceRef({
      type: RESOURCE_TYPE.ENTITY_VERSION,
      id: version.entityVersionId,
    }),
  );
  return Result.ok({
    versionId: version.entityVersionId,
    versionNumber: version.versionNumber,
  });
};
