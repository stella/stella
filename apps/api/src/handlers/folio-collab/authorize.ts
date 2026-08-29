import { Result } from "better-result";

import {
  parseFolioCollabRoomName,
  toFolioCollabRoomName,
} from "@stll/api-contract/folio-collab";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./room-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["roomName", "token"] }),
} satisfies TokenHandlerConfig;

const authorizeFolioCollabSessionHandler = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const roomId =
      typeof body?.roomName === "string"
        ? parseFolioCollabRoomName(body.roomName)
        : null;
    const { room: value } = yield* Result.await(
      authorizeFolioCollabCredentials({ roomId, token: body?.token }),
    );
    return Result.ok({
      canEdit: value.canEdit,
      generation: value.generation,
      roomId: value.roomId,
      roomName: toFolioCollabRoomName(value.roomId),
      tokenExpiresAt: value.tokenExpiresAt.toISOString(),
      userId: value.userId,
      userImage: value.userImage,
      userName: value.userName,
      workspaceId: value.workspaceId,
    });
  },
);

export default authorizeFolioCollabSessionHandler;
