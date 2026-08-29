import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadFolioCollabSnapshot } from "@/api/lib/folio-collab-rooms";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./room-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["roomId", "token"] }),
} satisfies TokenHandlerConfig;

const loadFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const { room: value } = yield* Result.await(
      authorizeFolioCollabCredentials(body),
    );

    const snapshot = await loadFolioCollabSnapshot(value);
    if (snapshot === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative editing room not found.",
        }),
      );
    }

    return Result.ok(snapshot);
  },
);

export default loadFolioCollabSnapshotHandler;
