import { Result } from "better-result";
import * as v from "valibot";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
import {
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  storeFolioCollabSnapshot,
} from "@/api/lib/folio-collab-rooms";
import { resolveFolioCollabServiceRoom } from "@/api/lib/folio-collab-service-room";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

import { verifyFolioCollabServiceCaller } from "./service-credentials";

const SNAPSHOT_STORE_FAILURE_SINK = failureSink({
  event: "folio_collab.snapshot_store",
  expected: [],
});

const config = {
  contract: "replace",
  precondition: {
    type: "deferred",
    baselineId: "apps/api/src/handlers/folio-collab/snapshot-store.ts",
  },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: {
    type: "none",
    reason:
      "Stores collaboration protocol state without delivering stored-file bytes.",
  },
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: v.object({
    expectedGeneration: v.pipe(v.number(), v.integer(), v.minValue(0)),
    expectedSnapshotRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    roomId: resourceIdSchema("folioCollabRoom"),
    snapshotBase64: v.pipe(
      v.string(),
      v.maxLength(FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH),
    ),
  }),
} satisfies TokenHandlerConfig;

const storeFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  verifyFolioCollabServiceCaller,
  async function* ({ body }) {
    const {
      expectedGeneration,
      expectedSnapshotRevision,
      roomId,
      snapshotBase64,
    } = body;
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

    const storedResult = await storeFolioCollabSnapshot({
      authority: { type: "collab-service" },
      expectedGeneration,
      expectedSnapshotRevision,
      snapshotBytes,
      value,
    });

    if (Result.isError(storedResult)) {
      if (storedResult.error instanceof OrganizationFileUsageError) {
        return Result.err(
          organizationFileUsageHandlerError(storedResult.error),
        );
      }
      observeFailure(storedResult.error, {
        sink: SNAPSHOT_STORE_FAILURE_SINK,
        ctx: {
          organizationId: value.organizationId,
          workspaceId: value.workspaceId,
        },
      });
      return Result.err(
        new HandlerError({
          status: 500,
          message: storedResult.error.message,
          cause: storedResult.error,
        }),
      );
    }
    const stored = storedResult.value;

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
          status: 428,
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
