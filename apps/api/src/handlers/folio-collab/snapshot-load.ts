import { Result } from "better-result";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { loadFolioCollabSnapshot } from "@/api/lib/folio-collab-sessions";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./session-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({ keys: ["sessionId", "token"] }),
} satisfies TokenHandlerConfig;

const loadFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const { session: value } = yield* Result.await(
      authorizeFolioCollabCredentials(body),
    );

    return Result.ok({
      snapshotBase64: await loadFolioCollabSnapshot(value),
    });
  },
);

export default loadFolioCollabSnapshotHandler;
