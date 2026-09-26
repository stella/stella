import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import { pdfSigningSessions } from "@/api/db/schema";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import type { DocumentSource } from "@/api/lib/document-source";
import { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import type { EntityVersionTargetErrorCode } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadPdfSigningBaseBytes } from "@/api/lib/pdf-signing/base-bytes";
import { closePdfSigningSession } from "@/api/lib/pdf-signing/close-session";
import {
  applySignature,
  PdfSigningDigestMismatchError,
} from "@/api/lib/pdf-signing/sign-pdf";
import type { AppliedSignature } from "@/api/lib/pdf-signing/sign-pdf";
import { configuredTimestampAuthorities } from "@/api/lib/pdf-signing/timestamp-authority";
import {
  permissiveBodySchema,
  permissiveRouteSchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { PDF_MIME_TYPE } from "@/api/mime-types";

import { authorizePdfSigningCredentials } from "./pdf-signing-credentials";

/** An RSA-4096 PKCS#1 signature is 512 bytes; base64 of it is under 1 KiB. */
const SIGNATURE_BASE64_MAX_LENGTH = 4096;

const signaturePayloadSchema = t.Object({
  signature: t.String({ minLength: 1, maxLength: SIGNATURE_BASE64_MAX_LENGTH }),
});

/**
 * HTTP status per version-writer rejection. Total over the writer's codes, so
 * a new rejection reaches a decision here rather than a generic 500.
 */
const VERSION_WRITE_STATUS = {
  "current-version-changed": 409,
  "current-version-not-found": 409,
  "document-too-large": 413,
  "edit-session-open": 409,
  "entity-not-found": 404,
  "entity-read-only": 409,
  "missing-file-field": 409,
  "source-version-not-found": 409,
  "target-file-not-found": 409,
  "workspace-not-active": 409,
} as const satisfies Record<EntityVersionTargetErrorCode, 404 | 409 | 413>;

const decodeBase64 = (value: string): Uint8Array | null => {
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.toString("base64") === value
    ? new Uint8Array(bytes)
    : null;
};

const decodeCertificateChain = (chain: string[] | null) =>
  (chain ?? []).map((entry) => new Uint8Array(Buffer.from(entry, "base64")));

/** Provenance of the signed version: what was signed, with what, how. */
const signatureSource = ({
  applied,
  baseVersionId,
  signerCertificateDer,
  signingTime,
}: {
  applied: AppliedSignature;
  baseVersionId: string;
  signerCertificateDer: Uint8Array;
  signingTime: Date;
}): DocumentSource => ({
  kind: "signature",
  baseVersionId,
  certificateSha256Hex: new Bun.CryptoHasher("sha256")
    .update(signerCertificateDer)
    .digest("hex"),
  level: applied.level,
  signingTime: signingTime.toISOString(),
  timestampAuthorityUrl: applied.timestampAuthorityUrl,
});

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["sessionToken", "signature"] }),
  params: permissiveRouteSchema({ keys: ["sessionId"] }),
} satisfies TokenHandlerConfig;

const submitPdfSigningSignature = createSafeTokenHandler(
  config,
  async function* ({ body, params, request, server }) {
    const session = yield* Result.await(
      authorizePdfSigningCredentials({
        sessionId: params.sessionId,
        sessionToken: body?.sessionToken,
      }),
    );

    const payload = validatePostAuth(signaturePayloadSchema, body);
    if (!payload.ok) {
      return Result.err(
        new HandlerError({ status: 400, message: payload.message }),
      );
    }

    const signature = decodeBase64(payload.value.signature);
    if (signature === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "The signature could not be read.",
        }),
      );
    }

    const { digestHex, keyType, signerCertificateDer, signingTime } = session;
    if (
      digestHex === null ||
      keyType === null ||
      signerCertificateDer === null ||
      signingTime === null
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          code: "pdf_signing_certificate_missing",
          message: "Post the signing certificate before the signature.",
        }),
      );
    }

    const recordAuditEvent = createAuditRecorder({
      organizationId: session.organizationId,
      workspaceId: session.workspaceId,
      userId: session.userId,
      request,
      server,
    });

    // The same read refuses a base the document has moved away from, so the
    // file name below is the pinned version's.
    const { bytes: basePdf, fileName } = yield* Result.await(
      loadPdfSigningBaseBytes({ recordAuditEvent, session }),
    );

    const signedPdf = await Result.tryPromise({
      try: async () =>
        await applySignature({
          basePdf,
          certificate: new Uint8Array(signerCertificateDer),
          certificateChain: decodeCertificateChain(
            session.signerCertificateChain,
          ),
          expectedDigestHex: digestHex,
          keyType,
          location: session.location,
          reason: session.reason,
          signature,
          signatureAlgorithm: keyType === "RSA" ? "RSASSA-PKCS1-v1_5" : "ECDSA",
          signingTime,
          timestampAuthorities: configuredTimestampAuthorities(),
        }),
      catch: (cause) => cause,
    });

    if (Result.isError(signedPdf)) {
      if (PdfSigningDigestMismatchError.is(signedPdf.error)) {
        yield* Result.await(
          closePdfSigningSession({
            closeReason: "digest_mismatch",
            recordAuditEvent,
            safeDb: session.safeDb,
            sessionId: session.sessionId,
          }),
        );
        return Result.err(
          new HandlerError({
            status: 409,
            code: "pdf_signing_digest_mismatch",
            message:
              "The prepared signature no longer matches this document. Start signing again.",
          }),
        );
      }
      return Result.err(
        new HandlerError({
          status: 422,
          code: "pdf_signing_failed",
          message: "The signature could not be embedded in this PDF.",
          cause: signedPdf.error,
        }),
      );
    }

    const written = await Result.tryPromise({
      try: async () =>
        await createEntityVersionFromBuffer({
          buffer: signedPdf.value.bytes,
          entityId: session.entityId,
          fileName,
          mimeType: PDF_MIME_TYPE,
          organizationId: session.organizationId,
          recordAuditEvent,
          safeDb: session.safeDb,
          source: signatureSource({
            applied: signedPdf.value,
            baseVersionId: session.baseVersionId,
            signerCertificateDer,
            signingTime,
          }),
          userId: session.userId,
          workspaceId: session.workspaceId,
          writePolicy: {
            type: "pdf-signature",
            expectedCurrentVersionId: session.baseVersionId,
            filePropertyId: session.propertyId,
          },
          afterWrite: async (tx, result) => {
            // Same transaction as the version write: an exchange can never be
            // marked finalized without the version it names, nor the reverse.
            await tx
              .update(pdfSigningSessions)
              .set({
                closedAt: new Date(),
                finalizedVersionId: result.entityVersionId,
                status: "finalized",
              })
              .where(eq(pdfSigningSessions.id, session.sessionId));

            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
              resourceId: session.sessionId,
              changes: {
                status: { old: "open", new: "finalized" },
                finalizedVersionId: { old: null, new: result.entityVersionId },
              },
            });
          },
        }),
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to store the signed document.",
          cause,
        }),
    });

    if (Result.isError(written)) {
      return Result.err(written.error);
    }
    if (Result.isError(written.value)) {
      const rejection = written.value.error;
      if (rejection.code === "current-version-changed") {
        yield* Result.await(
          closePdfSigningSession({
            closeReason: "base_version_diverged",
            recordAuditEvent,
            safeDb: session.safeDb,
            sessionId: session.sessionId,
          }),
        );
      }
      return Result.err(
        new HandlerError({
          status: VERSION_WRITE_STATUS[rejection.code],
          message: rejection.message,
        }),
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
  },
);

export default submitPdfSigningSignature;
