import { Result } from "better-result";
import { t } from "elysia";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadFolioCollabSnapshot } from "@/api/lib/folio-collab-rooms";
import { resolveFolioCollabServiceRoom } from "@/api/lib/folio-collab-service-room";
import {
  permissiveBodySchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabService } from "./service-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["roomId"] }),
} satisfies TokenHandlerConfig;

const strictBodySchema = t.Object({ roomId: tSafeId("folioCollabRoom") });

const loadFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  async function* ({ body, request }) {
    yield* authorizeFolioCollabService(request.headers.get("authorization"));

    const validatedBody = validatePostAuth(strictBodySchema, body);
    if (!validatedBody.ok) {
      return Result.err(
        new HandlerError({ status: 422, message: validatedBody.message }),
      );
    }
    const value = yield* Result.await(
      resolveFolioCollabServiceRoom(validatedBody.value.roomId),
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
