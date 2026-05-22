import { Result } from "better-result";
import { t } from "elysia";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeFolioCollabSession,
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  storeFolioCollabSnapshot,
} from "@/api/lib/folio-collab-sessions";

const config = {
  body: t.Object({
    sessionId: tSafeId("folioCollabSession"),
    snapshotBase64: t.String({
      maxLength: FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
    }),
    token: t.String({ minLength: 64, maxLength: 64 }),
  }),
} satisfies TokenHandlerConfig;

const storeFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  // eslint-disable-next-line require-yield -- token auth returns a plain Promise; nothing to Result.await
  async function* ({ body: { sessionId, snapshotBase64, token } }) {
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

    const { value } = authorized;
    if (!value.canEdit) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit is read-only.",
        }),
      );
    }

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
