import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeFolioCollabSession,
  loadFolioCollabSnapshot,
} from "@/api/lib/folio-collab-sessions";
import {
  permissiveBodySchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import {
  folioCollabSessionCredentialsSchema,
  folioCollabSessionNotFoundError,
} from "./session-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["sessionId", "token"] }),
} satisfies TokenHandlerConfig;

const loadFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  // eslint-disable-next-line require-yield -- token auth returns a plain Promise; nothing to Result.await
  async function* ({ body }) {
    const credentials = validatePostAuth(
      folioCollabSessionCredentialsSchema,
      body,
    );
    if (!credentials.ok) {
      return Result.err(folioCollabSessionNotFoundError());
    }
    const { sessionId, token } = credentials.value;

    const authorized = await authorizeFolioCollabSession({ sessionId, token });

    if (authorized.status === "missing") {
      return Result.err(folioCollabSessionNotFoundError());
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
