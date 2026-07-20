import { Result } from "better-result";
import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeFolioCollabSession,
  type AuthorizedFolioCollabSession,
} from "@/api/lib/folio-collab-sessions";
import { validatePostAuth } from "@/api/lib/permissive-route-schema";

/**
 * Folio-collab room tokens are two concatenated 32-char parts (see
 * `createFolioCollabToken` in `lib/folio-collab-sessions.ts`).
 */
const FOLIO_COLLAB_TOKEN_LENGTH = 64;

/**
 * Strict shape of the credential pair every folio-collab session endpoint
 * authorizes itself from. The route schemas are deliberately permissive
 * (see `lib/permissive-route-schema.ts`), so each handler applies this
 * schema itself as the first step of its credential check: a request whose
 * credentials do not even have the right shape must be indistinguishable
 * from one carrying unknown credentials.
 */
export const folioCollabSessionCredentialsSchema = t.Object({
  sessionId: tSafeId("folioCollabSession"),
  token: t.String({
    minLength: FOLIO_COLLAB_TOKEN_LENGTH,
    maxLength: FOLIO_COLLAB_TOKEN_LENGTH,
  }),
});

/**
 * The response for a session that cannot be authorized: unknown session,
 * unknown token, or credentials that are not even well-formed. One shared
 * construction so all three cases stay byte-identical on the wire.
 */
export const folioCollabSessionNotFoundError = () =>
  new HandlerError({
    status: 404,
    message: "Collaborative edit session not found.",
  });

/**
 * Validates and authorizes the shared folio-collab credential pair. Keeping
 * every auth-shaped response here prevents the token routes from drifting
 * into observably different behavior for malformed, missing, or revoked
 * credentials.
 */
export const authorizeFolioCollabCredentials = async (
  rawCredentials: unknown,
): Promise<
  Result<
    { session: AuthorizedFolioCollabSession; token: string },
    HandlerError<401 | 403 | 404>
  >
> => {
  const credentials = validatePostAuth(
    folioCollabSessionCredentialsSchema,
    rawCredentials,
  );
  if (!credentials.ok) {
    return Result.err(folioCollabSessionNotFoundError());
  }

  const authorized = await authorizeFolioCollabSession(credentials.value);
  if (authorized.status === "missing") {
    return Result.err(folioCollabSessionNotFoundError());
  }
  if (authorized.status === "token-expired") {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Collaborative edit token expired.",
      }),
    );
  }
  if (authorized.status === "permission-revoked") {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Collaborative edit permission revoked.",
      }),
    );
  }

  return Result.ok({
    session: authorized.value,
    token: credentials.value.token,
  });
};
