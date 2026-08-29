import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { touchFolioCollabRoom } from "@/api/lib/folio-collab-rooms";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./room-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["roomId", "token"] }),
} satisfies TokenHandlerConfig;

const heartbeatFolioCollabRoom = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const { room } = yield* Result.await(authorizeFolioCollabCredentials(body));
    const heartbeat = await touchFolioCollabRoom(room);
    if (heartbeat.status === "room-missing") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative editing room not found.",
        }),
      );
    }
    if (heartbeat.status === "desktop-conflict") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This document has a desktop edit session open.",
        }),
      );
    }
    if (heartbeat.status === "workspace-inactive") {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit access revoked.",
        }),
      );
    }

    return Result.ok({ activeAt: heartbeat.activeAt.toISOString() });
  },
);

export default heartbeatFolioCollabRoom;
