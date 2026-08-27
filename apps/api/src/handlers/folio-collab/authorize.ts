import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./room-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["roomId", "token"] }),
} satisfies TokenHandlerConfig;

const authorizeFolioCollabSessionHandler = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const { room: value } = yield* Result.await(
      authorizeFolioCollabCredentials(body),
    );
    return Result.ok({
      canEdit: value.canEdit,
      generation: value.generation,
      roomId: value.roomId,
      roomName: value.roomId,
      tokenExpiresAt: value.tokenExpiresAt.toISOString(),
      userId: value.userId,
      workspaceId: value.workspaceId,
    });
  },
);

export default authorizeFolioCollabSessionHandler;
