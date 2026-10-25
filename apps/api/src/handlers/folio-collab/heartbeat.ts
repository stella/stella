import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { touchFolioCollabRoom } from "@/api/lib/folio-collab-rooms";

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

const heartbeatFolioCollabRoom = createSafeTokenHandler(
  config,
  verifyFolioCollabRoomCaller,
  async function* ({ caller }) {
    const { room } = yield* Result.ok(caller);
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
