import { Result } from "better-result";
import * as v from "valibot";

import type { RawRouteInput } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  AuthorizedPdfSigningSession,
  PdfSigningSessionAuthorization,
} from "@/api/lib/files/pdf-signing/sessions";
import { authorizePdfSigningSession } from "@/api/lib/files/pdf-signing/sessions";
import { tokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { isRecord } from "@/api/lib/type-guards";

const SESSION_TOKEN_LENGTH = 64;

/** The session token a desktop-facing signing call carries in its body. */
export const pdfSigningSessionTokenSchema = v.pipe(
  v.string(),
  v.minLength(SESSION_TOKEN_LENGTH),
  v.maxLength(SESSION_TOKEN_LENGTH),
);

/** The path of a desktop-facing signing call. */
export const pdfSigningSessionParamsSchema = v.object({
  sessionId: resourceIdSchema("pdfSigningSession"),
});

/**
 * The credential every desktop-facing signing call carries: the session id
 * rides in the path and the token in the body.
 */
const credentialsSchema = v.object({
  ...pdfSigningSessionParamsSchema.entries,
  sessionToken: pdfSigningSessionTokenSchema,
});

/** The credential fields of a raw, unvalidated signing request. */
export const pdfSigningRawCredentials = ({ params, body }: RawRouteInput) => ({
  sessionId: params["sessionId"],
  sessionToken: isRecord(body) ? body["sessionToken"] : undefined,
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

export type FinalizeCredentials =
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
  const credentials = v.safeParse(credentialsSchema, rawCredentials);
  if (!credentials.success) {
    return Result.err(pdfSigningSessionNotFoundError());
  }
  const authorized = await authorizePdfSigningSession(
    credentials.output,
    tokenScopedDatabase,
  );
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
const authorizePdfSigningCredentials = async (
  rawCredentials: unknown,
): Promise<
  Result<AuthorizedPdfSigningSession, HandlerError<401 | 403 | 404>>
> => {
  const credentials = v.safeParse(credentialsSchema, rawCredentials);
  if (!credentials.success) {
    return Result.err(pdfSigningSessionNotFoundError());
  }
  return openSessionOrError(
    await authorizePdfSigningSession(credentials.output, tokenScopedDatabase),
  );
};

/** A desktop-facing signing call's caller: the open session its credential names. */
export const verifyPdfSigningCaller = async (
  raw: RawRouteInput,
): Promise<
  Result<AuthorizedPdfSigningSession, HandlerError<401 | 403 | 404>>
> => await authorizePdfSigningCredentials(pdfSigningRawCredentials(raw));
