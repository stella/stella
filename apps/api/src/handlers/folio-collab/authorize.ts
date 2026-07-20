import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./session-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["sessionId", "token"] }),
} satisfies TokenHandlerConfig;

const authorizeFolioCollabSessionHandler = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const { session: value } = yield* Result.await(
      authorizeFolioCollabCredentials(body),
    );
    return Result.ok({
      canEdit: value.canEdit,
      roomName: value.sessionId,
      sessionId: value.sessionId,
      tokenExpiresAt: value.tokenExpiresAt.toISOString(),
      userId: value.userId,
      workspaceId: value.workspaceId,
    });
  },
);

export default authorizeFolioCollabSessionHandler;
