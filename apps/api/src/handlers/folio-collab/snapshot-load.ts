import { Result } from "better-result";
import { t } from "elysia";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeFolioCollabSession,
  loadFolioCollabSnapshot,
} from "@/api/lib/folio-collab-sessions";

const config = {
  body: t.Object({
    sessionId: tSafeId("folioCollabSession"),
    token: t.String({ minLength: 64, maxLength: 64 }),
  }),
} satisfies TokenHandlerConfig;

const loadFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  // eslint-disable-next-line require-yield -- token auth returns a plain Promise; nothing to Result.await
  async function* ({ body: { sessionId, token } }) {
    const authorized = await authorizeFolioCollabSession({ sessionId, token });

    if (authorized.status === "missing") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative edit session not found.",
        }),
      );
    }
    if (authorized.status === "token-expired") {
      return Result.err(
        new HandlerError({
          status: 401,
          message: "Collaborative edit token expired.",
        }),
      );
    }
    if (authorized.status === "permission-revoked") {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit permission revoked.",
        }),
      );
    }

    return Result.ok({
      snapshotBase64: await loadFolioCollabSnapshot(authorized.value),
    });
  },
);

export default loadFolioCollabSnapshotHandler;
