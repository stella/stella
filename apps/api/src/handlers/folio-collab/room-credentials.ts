import { Result } from "better-result";
import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeFolioCollabRoom,
  type AuthorizedFolioCollabRoom,
} from "@/api/lib/folio-collab-rooms";
import { validatePostAuth } from "@/api/lib/permissive-route-schema";

const FOLIO_COLLAB_TOKEN_LENGTH = 64;

export const folioCollabRoomCredentialsSchema = t.Object({
  roomId: tSafeId("folioCollabRoom"),
  token: t.String({
    minLength: FOLIO_COLLAB_TOKEN_LENGTH,
    maxLength: FOLIO_COLLAB_TOKEN_LENGTH,
  }),
});

export const folioCollabRoomNotFoundError = () =>
  new HandlerError({
    status: 404,
    message: "Collaborative editing room not found.",
  });

export const authorizeFolioCollabCredentials = async (
  rawCredentials: unknown,
): Promise<
  Result<
    { room: AuthorizedFolioCollabRoom; token: string },
    HandlerError<401 | 403 | 404>
  >
> => {
  const credentials = validatePostAuth(
    folioCollabRoomCredentialsSchema,
    rawCredentials,
  );
  if (!credentials.ok) {
    return Result.err(folioCollabRoomNotFoundError());
  }

  const authorized = await authorizeFolioCollabRoom(credentials.value);
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
    token: credentials.value.token,
  });
};
