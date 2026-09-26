/**
 * Phase 2: the desktop posts its signature and the API embeds it.
 *
 * Contract for the desktop:
 * - 200: the signed version exists. A repeat of a call that already
 *   finalized answers the same way, so a lost response is safe to retry.
 * - 503: a transient failure. The exchange stays open, the verified
 *   signature is kept, and posting the same signature again retries without
 *   a new PIN, within the attempt cap and the session's TTL.
 * - 409, 413, 422: the exchange is closed with the reason the browser shows.
 * - 400, 401, 403, 404: the request itself was refused; nothing changed.
 */

import { Result } from "better-result";
import { t } from "elysia";

import type { PdfSigningSessionCloseReason } from "@/api/db/schema";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { closePdfSigningSession } from "@/api/lib/pdf-signing/close-session";
import { finalizeSignature, retryable } from "@/api/lib/pdf-signing/finalize";
import type { PreparedSigningState } from "@/api/lib/pdf-signing/finalize";
import {
  claimFinalizeAttempt,
  MAX_FINALIZE_ATTEMPTS,
  releaseFinalizeAttempt,
  storeDesktopSignature,
} from "@/api/lib/pdf-signing/finalize-attempts";
import type { AuthorizedPdfSigningSession } from "@/api/lib/pdf-signing/sessions";
import { verifyDesktopSignature } from "@/api/lib/pdf-signing/verify-signature";
import {
  permissiveBodySchema,
  permissiveRouteSchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import { authorizePdfSigningFinalizeCredentials } from "./pdf-signing-credentials";

/** An RSA-8192 PKCS#1 signature is 1024 bytes; base64 of it is under 2 KiB. */
const SIGNATURE_BASE64_MAX_LENGTH = 4096;

const signaturePayloadSchema = t.Object({
  signature: t.String({ minLength: 1, maxLength: SIGNATURE_BASE64_MAX_LENGTH }),
});

const decodeBase64 = (value: string): Uint8Array | null => {
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.toString("base64") === value
    ? new Uint8Array(bytes)
    : null;
};

const signingSessionNotFound = () =>
  new HandlerError({ status: 404, message: "Signing session not found." });

const signatureConflict = () =>
  new HandlerError({
    status: 400,
    code: "pdf_signing_signature_conflict",
    message: "This session already holds a different signature.",
  });

const attemptsExhausted = () =>
  new HandlerError({
    status: 422,
    code: "pdf_signing_finalize_attempts_exhausted",
    message: "The signature could not be added after several attempts.",
  });

/** Everything phase 1 stored, or `null` when the certificate never arrived. */
const preparedState = ({
  digestHex,
  keyType,
  placeholderSize,
  signedAttributes,
  signerCertificateDer,
  signingTime,
}: AuthorizedPdfSigningSession): PreparedSigningState | null =>
  digestHex === null ||
  keyType === null ||
  placeholderSize === null ||
  signedAttributes === null ||
  signerCertificateDer === null ||
  signingTime === null
    ? null
    : {
        digestHex,
        keyType,
        placeholderSize,
        signedAttributes,
        signerCertificateDer,
        signingTime,
      };

type SessionContext = {
  recordAuditEvent: AuditRecorder;
  session: AuthorizedPdfSigningSession;
};

/** End the exchange for a failure no retry can fix, then report it. */
const closeAndFail = async (
  { recordAuditEvent, session }: SessionContext,
  closeReason: PdfSigningSessionCloseReason,
  error: HandlerError,
): Promise<Result<never, HandlerError>> => {
  const closed = await closePdfSigningSession({
    closeReason,
    recordAuditEvent,
    safeDb: session.safeDb,
    sessionId: session.sessionId,
  });
  return Result.err(Result.isError(closed) ? closed.error : error);
};

/**
 * Verify the posted signature once and keep it. A signature that was
 * already kept is only compared: it was verified when it arrived, and a
 * retry may repeat it but never replace it.
 */
const acceptSignature = async (
  context: SessionContext,
  prepared: PreparedSigningState,
  signature: Uint8Array,
): Promise<Result<void, HandlerError>> => {
  const { session } = context;
  if (session.signature !== null) {
    return Buffer.from(session.signature).equals(Buffer.from(signature))
      ? Result.ok(undefined)
      : Result.err(signatureConflict());
  }

  // Checked before any PDF work: a signature that does not verify would
  // only produce a document every validator rejects.
  const verified = verifyDesktopSignature({
    certificate: prepared.signerCertificateDer,
    keyType: prepared.keyType,
    signature,
    signedAttributes: prepared.signedAttributes,
  });
  if (!verified) {
    return await closeAndFail(
      context,
      "signature_invalid",
      new HandlerError({
        status: 422,
        code: "pdf_signing_signature_invalid",
        message:
          "The signature does not match the selected certificate. Start signing again.",
      }),
    );
  }

  const stored = await session.safeDb(
    async (tx) =>
      await storeDesktopSignature({
        sessionId: session.sessionId,
        signature,
        tx,
      }),
  );
  if (Result.isError(stored)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to keep the signature.",
        cause: stored.error,
      }),
    );
  }
  if (stored.value.status === "closed") {
    return Result.err(signingSessionNotFound());
  }
  return stored.value.status === "conflict"
    ? Result.err(signatureConflict())
    : Result.ok(undefined);
};

/** Start an attempt, or explain why none may start now. */
const claimAttempt = async (
  context: SessionContext,
): Promise<Result<number, HandlerError>> => {
  const { session } = context;
  const claim = await session.safeDb(
    async (tx) =>
      await claimFinalizeAttempt({
        now: new Date(),
        sessionId: session.sessionId,
        tx,
      }),
  );
  if (Result.isError(claim)) {
    return Result.err(
      retryable(
        "pdf_signing_finalize_unavailable",
        "Signing could not start. Try again.",
        claim.error,
      ).error,
    );
  }
  switch (claim.value.status) {
    case "claimed": {
      return Result.ok(claim.value.attempt);
    }
    case "in-progress": {
      return Result.err(
        retryable(
          "pdf_signing_finalize_in_progress",
          "This signature is still being added. Try again shortly.",
        ).error,
      );
    }
    case "exhausted": {
      return await closeAndFail(context, "signing_failed", attemptsExhausted());
    }
    case "closed": {
      return Result.err(signingSessionNotFound());
    }
  }
};

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["sessionToken", "signature"] }),
  params: permissiveRouteSchema({ keys: ["sessionId"] }),
} satisfies TokenHandlerConfig;

const submitPdfSigningSignature = createSafeTokenHandler(
  config,
  async function* ({ body, params, request, server }) {
    const credentials = yield* Result.await(
      authorizePdfSigningFinalizeCredentials({
        sessionId: params.sessionId,
        sessionToken: body?.sessionToken,
      }),
    );
    if (credentials.kind === "finalized") {
      return Result.ok({
        versionId: credentials.versionId,
        versionNumber: credentials.versionNumber,
      });
    }
    const { session } = credentials;

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

    const prepared = preparedState(session);
    if (prepared === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "pdf_signing_certificate_missing",
          message: "Post the signing certificate before the signature.",
        }),
      );
    }

    const context: SessionContext = {
      recordAuditEvent: createAuditRecorder({
        organizationId: session.organizationId,
        workspaceId: session.workspaceId,
        userId: session.userId,
        request,
        server,
      }),
      session,
    };

    yield* Result.await(acceptSignature(context, prepared, signature));
    const attempt = yield* Result.await(claimAttempt(context));

    const finalized = await finalizeSignature({
      ...context,
      prepared,
      signature,
    });
    if (Result.isOk(finalized)) {
      return Result.ok(finalized.value);
    }

    const failure = finalized.error;
    if (failure.kind === "retryable" && attempt < MAX_FINALIZE_ATTEMPTS) {
      yield* Result.await(
        session.safeDb(
          async (tx) =>
            await releaseFinalizeAttempt({ sessionId: session.sessionId, tx }),
        ),
      );
      return Result.err(failure.error);
    }
    // A terminal failure, or the last attempt failing: either way no retry
    // is left, so the exchange closes rather than waiting out its TTL.
    return failure.kind === "terminal"
      ? await closeAndFail(context, failure.closeReason, failure.error)
      : await closeAndFail(context, "signing_failed", attemptsExhausted());
  },
);

export default submitPdfSigningSignature;
