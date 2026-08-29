import { Result } from "better-result";
import { t } from "elysia";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  storeFolioCollabSnapshot,
} from "@/api/lib/folio-collab-rooms";
import { resolveFolioCollabServiceRoom } from "@/api/lib/folio-collab-service-room";
import {
  permissiveBodySchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabService } from "./service-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({
    keys: [
      "expectedGeneration",
      "expectedSnapshotRevision",
      "roomId",
      "snapshotBase64",
    ],
  }),
} satisfies TokenHandlerConfig;

/** Validated after authorization; see `permissive-route-schema.ts`. */
const strictBodySchema = t.Object({
  expectedGeneration: t.Integer({ minimum: 0 }),
  expectedSnapshotRevision: t.Integer({ minimum: 0 }),
  roomId: tSafeId("folioCollabRoom"),
  snapshotBase64: t.String({
    maxLength: FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  }),
});

const storeFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  async function* ({ body, request }) {
    yield* authorizeFolioCollabService(request.headers.get("authorization"));

    const validatedBody = validatePostAuth(strictBodySchema, body);
    if (!validatedBody.ok) {
      return Result.err(
        new HandlerError({ status: 422, message: validatedBody.message }),
      );
    }
    const {
      expectedGeneration,
      expectedSnapshotRevision,
      roomId,
      snapshotBase64,
    } = validatedBody.value;
    const value = yield* Result.await(resolveFolioCollabServiceRoom(roomId));

    const snapshotBytes = Buffer.from(snapshotBase64, "base64");
    if (snapshotBytes.byteLength > FOLIO_COLLAB_SNAPSHOT_MAX_BYTES) {
      return Result.err(
        new HandlerError({
          status: 413,
          message: "Collaborative snapshot too large.",
        }),
      );
    }

    const stored = await storeFolioCollabSnapshot({
      authority: { type: "collab-service" },
      expectedGeneration,
      expectedSnapshotRevision,
      snapshotBytes,
      value,
    });

    if (stored.status === "room-missing") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative editing room not found.",
        }),
      );
    }
    if (stored.status === "generation-conflict") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Collaborative room generation changed.",
        }),
      );
    }
    if (stored.status === "snapshot-revision-conflict") {
      return Result.err(
        new HandlerError({
          code: "folio_collab_snapshot_revision_changed",
          status: 412,
          message: "Collaborative snapshot revision changed.",
        }),
      );
    }
    if (stored.status === "seed-owner-conflict") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Collaborative room has not been seeded.",
        }),
      );
    }
    if (stored.status === "workspace-inactive") {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit access revoked.",
        }),
      );
    }

    return Result.ok({
      generation: expectedGeneration,
      snapshotRevision: stored.snapshotRevision,
      storedAt: stored.storedAt.toISOString(),
    });
  },
);

export default storeFolioCollabSnapshotHandler;
