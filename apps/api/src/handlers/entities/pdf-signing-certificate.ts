import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { pdfSigningSessions } from "@/api/db/schema";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadPdfSigningBaseBytes } from "@/api/lib/pdf-signing/base-bytes";
import { inspectSigningCertificate } from "@/api/lib/pdf-signing/certificate";
import { completeCertificateChain } from "@/api/lib/pdf-signing/certificate-chain";
import { closePdfSigningSession } from "@/api/lib/pdf-signing/close-session";
import {
  captureSigningDigest,
  PdfSigningCertifiedDocumentError,
  signaturePlaceholderSize,
} from "@/api/lib/pdf-signing/sign-pdf";
import { configuredTimestampAuthorities } from "@/api/lib/pdf-signing/timestamp-authority";
import {
  permissiveBodySchema,
  permissiveRouteSchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import { authorizePdfSigningCredentials } from "./pdf-signing-credentials";

/** DER certificates are small; the cap keeps a hostile body bounded. */
const CERTIFICATE_BASE64_MAX_LENGTH = 16_384;
const CERTIFICATE_CHAIN_MAX_LENGTH = 8;

const certificatePayloadSchema = t.Object({
  certificate: t.String({
    minLength: 1,
    maxLength: CERTIFICATE_BASE64_MAX_LENGTH,
  }),
  certificateChain: t.Array(
    t.String({ minLength: 1, maxLength: CERTIFICATE_BASE64_MAX_LENGTH }),
    { maxItems: CERTIFICATE_CHAIN_MAX_LENGTH },
  ),
});

const decodeBase64Der = (value: string): Uint8Array | null => {
  const bytes = Buffer.from(value, "base64");
  // Buffer.from ignores anything it cannot decode, so a round trip is the
  // only way to tell valid base64 from silently truncated input.
  return bytes.length > 0 && bytes.toString("base64") === value
    ? new Uint8Array(bytes)
    : null;
};

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({
    keys: ["sessionToken", "certificate"],
    passthroughKeys: ["certificateChain"],
  }),
  params: permissiveRouteSchema({ keys: ["sessionId"] }),
} satisfies TokenHandlerConfig;

const submitPdfSigningCertificate = createSafeTokenHandler(
  config,
  async function* ({ body, params, request, server }) {
    const session = yield* Result.await(
      authorizePdfSigningCredentials({
        sessionId: params.sessionId,
        sessionToken: body?.sessionToken,
      }),
    );

    const payload = validatePostAuth(certificatePayloadSchema, body);
    if (!payload.ok) {
      return Result.err(
        new HandlerError({ status: 400, message: payload.message }),
      );
    }

    const certificate = decodeBase64Der(payload.value.certificate);
    const chain = payload.value.certificateChain.map(decodeBase64Der);
    if (certificate === null || chain.includes(null)) {
      return Result.err(
        new HandlerError({
          status: 422,
          code: "pdf_signing_certificate_rejected",
          message: "The signing certificate could not be read.",
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

    const signingTime = session.signingTime ?? new Date();
    const inspection = inspectSigningCertificate(certificate, signingTime);
    if (inspection.status === "rejected") {
      yield* Result.await(
        closePdfSigningSession({
          closeReason: "certificate_rejected",
          recordAuditEvent,
          safeDb: session.safeDb,
          sessionId: session.sessionId,
        }),
      );
      return Result.err(
        new HandlerError({
          status: 422,
          code: `pdf_signing_certificate_${inspection.reason}`,
          message: "This certificate cannot be used to sign.",
        }),
      );
    }

    // A retried POST with the same certificate must answer with the digest the
    // desktop is already signing, never a second one: the signing time is
    // pinned on first success, so re-running phase 1 would otherwise mint a
    // digest over different bytes.
    if (
      session.digestHex !== null &&
      session.signerCertificateDer !== null &&
      Buffer.from(session.signerCertificateDer).equals(certificate)
    ) {
      return Result.ok({
        digestAlgorithm: "SHA-256" as const,
        digestHex: session.digestHex,
        signatureAlgorithm: inspection.signatureAlgorithm,
      });
    }
    // Once a signature is kept, re-preparing would publish a digest that
    // signature does not cover.
    if (session.signature !== null) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "pdf_signing_signature_already_submitted",
          message: "This session already holds a signature.",
        }),
      );
    }

    const { bytes: basePdf } = yield* Result.await(
      loadPdfSigningBaseBytes({ recordAuditEvent, session }),
    );

    // The keychain builds its chain offline, so intermediates are often
    // missing; the stored chain is the verified, completed one.
    const { chain: signerChain } = await completeCertificateChain({
      candidates: chain.filter((entry) => entry !== null),
      certificate,
    });

    const timestamped = configuredTimestampAuthorities().length > 0;
    const placeholderSize = signaturePlaceholderSize({
      certificate,
      certificateChain: signerChain,
      timestamped,
    });
    const captured = await Result.tryPromise({
      try: async () =>
        await captureSigningDigest({
          basePdf,
          certificate,
          certificateChain: signerChain,
          keyType: inspection.keyType,
          location: session.location,
          placeholderSize,
          reason: session.reason,
          reserveTimestamp: timestamped,
          signatureAlgorithm: inspection.signatureAlgorithm,
          signingTime,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(captured)) {
      // Preparing is deterministic over the stored bytes, so a document that
      // cannot be prepared now never will be: the exchange ends here, before
      // the desktop asks for a PIN, rather than lingering until it expires.
      const certified = PdfSigningCertifiedDocumentError.is(captured.error);
      yield* Result.await(
        closePdfSigningSession({
          closeReason: certified ? "certified_document" : "signing_failed",
          recordAuditEvent,
          safeDb: session.safeDb,
          sessionId: session.sessionId,
        }),
      );
      return Result.err(
        new HandlerError({
          status: 422,
          code: certified
            ? "pdf_signing_certified_document"
            : "pdf_signing_prepare_failed",
          message: certified
            ? "This PDF is certified and its certification does not allow further signatures."
            : "This PDF could not be prepared for signing.",
          cause: captured.error,
        }),
      );
    }
    const { digestHex, signedAttributes } = captured.value;

    yield* Result.await(
      session.safeDb(async (tx) => {
        // audit: skip — the certificate and digest are the prepared state of
        // an already-audited exchange, not a state transition. The CREATE is
        // recorded when the exchange opens and the UPDATE when it closes.
        await tx
          .update(pdfSigningSessions)
          .set({
            digestHex,
            keyType: inspection.keyType,
            placeholderSize,
            signedAttributes: Buffer.from(signedAttributes),
            signerCertificateChain: signerChain.map((der) =>
              Buffer.from(der).toString("base64"),
            ),
            signerCertificateDer: Buffer.from(certificate),
            signingTime,
          })
          .where(eq(pdfSigningSessions.id, session.sessionId));
      }),
    );

    return Result.ok({
      digestAlgorithm: "SHA-256" as const,
      digestHex,
      signatureAlgorithm: inspection.signatureAlgorithm,
    });
  },
);

export default submitPdfSigningCertificate;
