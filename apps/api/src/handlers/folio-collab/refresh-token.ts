import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  recordFolioCollabContribution,
  refreshFolioCollabToken as refreshStoredFolioCollabToken,
} from "@/api/lib/folio-collab-rooms";

import {
  folioCollabRoomCredentialsSchema,
  verifyFolioCollabRoomCaller,
} from "./room-credentials";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: folioCollabRoomCredentialsSchema,
} satisfies TokenHandlerConfig;

const refreshFolioCollabToken = createSafeTokenHandler(
  config,
  verifyFolioCollabRoomCaller,
  async function* ({ caller }) {
    const { room: value, token } = yield* Result.ok(caller);
    const refreshed = await value.scopedDb(async (tx) => {
      const tokenRefresh = await refreshStoredFolioCollabToken({
        tokenId: value.tokenId,
        sourceSessionExpiresAt: value.sourceSessionExpiresAt,
        tx,
      });
      if (!tokenRefresh) {
        return null;
      }
      await recordFolioCollabContribution({
        roomId: value.roomId,
        tx,
        userId: value.userId,
        workspaceId: value.workspaceId,
      });
      return tokenRefresh;
    });

    if (!refreshed) {
      return Result.err(
        new HandlerError({
          status: 401,
          message: "Collaborative edit token expired.",
        }),
      );
    }

    return Result.ok({
      canEdit: value.canEdit,
      generation: value.generation,
      token,
      tokenExpiresAt: refreshed.tokenExpiresAt.toISOString(),
    });
  },
);

export default refreshFolioCollabToken;
