import { Result } from "better-result";
import * as v from "valibot";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadFolioCollabSnapshot } from "@/api/lib/folio-collab-rooms";
import { resolveFolioCollabServiceRoom } from "@/api/lib/folio-collab-service-room";

import { verifyFolioCollabServiceCaller } from "./service-credentials";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: {
    type: "none",
    reason:
      "Returns collaboration protocol state to the authorized collaboration service.",
  },
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: v.object({
    roomId: resourceIdSchema("folioCollabRoom"),
  }),
} satisfies TokenHandlerConfig;

const loadFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  verifyFolioCollabServiceCaller,
  async function* ({ body }) {
    const value = yield* Result.await(
      resolveFolioCollabServiceRoom(body.roomId),
    );

    const snapshot = yield* Result.await(loadFolioCollabSnapshot(value));
    if (snapshot === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative editing room not found.",
        }),
      );
    }

    return Result.ok(snapshot.snapshot);
  },
);

export default loadFolioCollabSnapshotHandler;
