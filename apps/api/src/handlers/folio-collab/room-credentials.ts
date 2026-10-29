import { Result } from "better-result";
import * as v from "valibot";

import { ownerSyntheticSessionAuthorityReader } from "@/api/db/root";
import type { VerifyCaller } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  type AuthorizedFolioCollabRoom,
  authorizeFolioCollabRoom,
} from "@/api/lib/folio-collab-rooms";

const FOLIO_COLLAB_TOKEN_LENGTH = 64;

/** A collaborative edit token as the room credential carries it. */
export const folioCollabTokenSchema = v.pipe(
  v.string(),
  v.minLength(FOLIO_COLLAB_TOKEN_LENGTH),
  v.maxLength(FOLIO_COLLAB_TOKEN_LENGTH),
);

/** The room credential a collaborating client sends in its body. */
export const folioCollabRoomCredentialsSchema = v.object({
  roomId: resourceIdSchema("folioCollabRoom"),
  token: folioCollabTokenSchema,
});

export type AuthorizedFolioCollabCredentials = {
  room: AuthorizedFolioCollabRoom;
  token: string;
};

const folioCollabRoomNotFoundError = () =>
  new HandlerError({
    status: 404,
    message: "Collaborative editing room not found.",
  });

/**
 * Authorize a room credential read from an unvalidated request. A malformed
 * credential answers exactly like an unknown room, so a probe cannot tell
 * "wrong shape" from "no such room".
 */
export const authorizeFolioCollabCredentials = async (
  rawCredentials: unknown,
): Promise<
  Result<AuthorizedFolioCollabCredentials, HandlerError<401 | 403 | 404 | 409>>
> => {
  const credentials = v.safeParse(
    folioCollabRoomCredentialsSchema,
    rawCredentials,
  );
  if (!credentials.success) {
    return Result.err(folioCollabRoomNotFoundError());
  }

  const authorized = await authorizeFolioCollabRoom({
    ...credentials.output,
    readSessionAuthority: ownerSyntheticSessionAuthorityReader,
  });
  if (authorized.status === "missing") {
    return Result.err(folioCollabRoomNotFoundError());
  }
  if (authorized.status === "token-expired") {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Collaborative edit token expired.",
      }),
    );
  }
  if (authorized.status === "generation-conflict") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Collaborative room generation changed.",
      }),
    );
  }
  if (authorized.status === "workspace-access-revoked") {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Collaborative edit access revoked.",
      }),
    );
  }

  return Result.ok({
    room: authorized.value,
    token: credentials.output.token,
  });
};

/** A room endpoint's caller: the room credential in its body. */
export const verifyFolioCollabRoomCaller: VerifyCaller<
  AuthorizedFolioCollabCredentials
> = async ({ body }) => await authorizeFolioCollabCredentials(body);
