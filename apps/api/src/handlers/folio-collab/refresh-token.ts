import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { refreshFolioCollabToken as refreshStoredFolioCollabToken } from "@/api/lib/folio-collab-sessions";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./session-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["sessionId", "token"] }),
} satisfies TokenHandlerConfig;

const refreshFolioCollabToken = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const { session: value, token } = yield* Result.await(
      authorizeFolioCollabCredentials(body),
    );
    const refreshed = await value.scopedDb(
      async (tx) =>
        await refreshStoredFolioCollabToken({
          sessionCreatedAt: value.sessionCreatedAt,
          tokenId: value.tokenId,
          tx,
        }),
    );

    if (!refreshed) {
      return Result.err(
        new HandlerError({
          status: 401,
          message: "Collaborative edit token expired.",
        }),
      );
    }

    return Result.ok({
      token,
      tokenExpiresAt: refreshed.tokenExpiresAt.toISOString(),
    });
  },
);

export default refreshFolioCollabToken;
