import { Result } from "better-result";
import { t } from "elysia";

import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  AuthorizedPdfSigningSession,
  PdfSigningSessionAuthorization,
} from "@/api/lib/pdf-signing/sessions";
import { authorizePdfSigningSession } from "@/api/lib/pdf-signing/sessions";
import { validatePostAuth } from "@/api/lib/permissive-route-schema";

const SESSION_TOKEN_LENGTH = 64;

/**
 * The credential every desktop-facing signing call carries. The session id
 * rides in the path and the token in the body; both are validated only after
 * the permissive route schema has let the request reach the handler.
 */
const credentialsSchema = t.Object({
  sessionId: tSafeId("pdfSigningSession"),
  sessionToken: t.String({
    minLength: SESSION_TOKEN_LENGTH,
    maxLength: SESSION_TOKEN_LENGTH,
  }),
});

const pdfSigningSessionNotFoundError = () =>
  new HandlerError({
    status: 404,
    code: "pdf_signing_session_not_found",
    message: "Signing session not found.",
  });

const openSessionOrError = (
  authorized: PdfSigningSessionAuthorization,
): Result<AuthorizedPdfSigningSession, HandlerError<401 | 403 | 404>> => {
  if (authorized.status === "missing" || authorized.status === "finalized") {
    return Result.err(pdfSigningSessionNotFoundError());
  }
  if (authorized.status === "token-expired") {
    return Result.err(
      new HandlerError({
        status: 401,
        code: "pdf_signing_session_expired",
        message: "This signing session expired. Start signing again.",
      }),
    );
  }
  if (authorized.status === "permission-revoked") {
    return Result.err(
      new HandlerError({
        status: 403,
        code: "pdf_signing_permission_revoked",
        message: "Permission to change this document was revoked.",
      }),
    );
  }

  return Result.ok(authorized.value);
};

type FinalizeCredentials =
  | { kind: "open"; session: AuthorizedPdfSigningSession }
  | {
      kind: "finalized";
      versionId: SafeId<"entityVersion">;
      versionNumber: number;
    };

/**
 * Authorize the finalizing call. Unlike every other desktop call it also
 * answers for an exchange this token already finalized, so a retry after a
 * lost response learns the version instead of a bare 404.
 */
export const authorizePdfSigningFinalizeCredentials = async (
  rawCredentials: unknown,
): Promise<Result<FinalizeCredentials, HandlerError<401 | 403 | 404>>> => {
  const credentials = validatePostAuth(credentialsSchema, rawCredentials);
  if (!credentials.ok) {
    return Result.err(pdfSigningSessionNotFoundError());
  }
  const authorized = await authorizePdfSigningSession(credentials.value);
  if (authorized.status === "finalized") {
    return Result.ok({
      kind: "finalized",
      versionId: authorized.versionId,
      versionNumber: authorized.versionNumber,
    });
  }
  const session = openSessionOrError(authorized);
  return Result.isError(session)
    ? Result.err(session.error)
    : Result.ok({ kind: "open", session: session.value });
};

/**
 * Authorize a desktop-facing call.
 *
 * A malformed credential answers exactly like an unknown one, so a probe
 * cannot distinguish "wrong shape" from "no such session" from "already
 * closed".
 */
export const authorizePdfSigningCredentials = async (
  rawCredentials: unknown,
): Promise<
  Result<AuthorizedPdfSigningSession, HandlerError<401 | 403 | 404>>
> => {
  const credentials = validatePostAuth(credentialsSchema, rawCredentials);
  if (!credentials.ok) {
    return Result.err(pdfSigningSessionNotFoundError());
  }
  return openSessionOrError(
    await authorizePdfSigningSession(credentials.value),
  );
};
