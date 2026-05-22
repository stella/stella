import { Result } from "better-result";
import { t } from "elysia";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeFolioCollabSession,
  issueFolioCollabToken,
} from "@/api/lib/folio-collab-sessions";

const config = {
  body: t.Object({
    sessionId: tSafeId("folioCollabSession"),
    token: t.String({ minLength: 64, maxLength: 64 }),
  }),
} satisfies TokenHandlerConfig;

const refreshFolioCollabToken = createSafeTokenHandler(
  config,
  // eslint-disable-next-line require-yield -- token auth + scopedDb returns plain Promises; nothing to Result.await
  async function* ({ body: { sessionId, token } }) {
    const authorized = await authorizeFolioCollabSession({ sessionId, token });

    if (authorized.status === "missing") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative edit session not found.",
        }),
      );
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

    const { value } = authorized;
    const { token: nextToken, tokenExpiresAt } = await value.scopedDb(
      async (tx) =>
        await issueFolioCollabToken({
          permissions: { canEdit: value.canEdit },
          sessionId: value.sessionId,
          tx,
          userId: value.userId,
          workspaceId: value.workspaceId,
        }),
    );

    return Result.ok({
      token: nextToken,
      tokenExpiresAt: tokenExpiresAt.toISOString(),
    });
  },
);

export default refreshFolioCollabToken;
