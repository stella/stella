import { Result } from "better-result";
import { t } from "elysia";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  storeFolioCollabSnapshot,
} from "@/api/lib/folio-collab-sessions";
import {
  permissiveBodySchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./session-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({
    keys: ["sessionId", "snapshotBase64", "token"],
  }),
} satisfies TokenHandlerConfig;

/** Validated after authorization; see `permissive-route-schema.ts`. */
const strictBodySchema = t.Object({
  snapshotBase64: t.String({
    maxLength: FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  }),
});

const storeFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const { session: value } = yield* Result.await(
      authorizeFolioCollabCredentials(body),
    );
    if (!value.canEdit) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit is read-only.",
        }),
      );
    }

    const validatedBody = validatePostAuth(strictBodySchema, body);
    if (!validatedBody.ok) {
      return Result.err(
        new HandlerError({ status: 422, message: validatedBody.message }),
      );
    }
    const { snapshotBase64 } = validatedBody.value;

    const snapshotBytes = Buffer.from(snapshotBase64, "base64");
    if (snapshotBytes.byteLength > FOLIO_COLLAB_SNAPSHOT_MAX_BYTES) {
      return Result.err(
        new HandlerError({
          status: 413,
          message: "Collaborative snapshot too large.",
        }),
      );
    }

    const { storedAt } = await storeFolioCollabSnapshot({
      snapshotBytes,
      value,
    });

    return Result.ok({ storedAt: storedAt.toISOString() });
  },
);

export default storeFolioCollabSnapshotHandler;
