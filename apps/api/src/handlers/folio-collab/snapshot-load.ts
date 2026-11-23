import { Result } from "better-result";
import * as v from "valibot";

import {
  FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME,
  type FolioCollabSnapshotLoadResponse,
} from "@stll/api-contract/folio-collab";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  type FolioCollabSnapshotTarget,
  loadFolioCollabSnapshot,
  readFolioCollabSeedDocx,
} from "@/api/lib/folio-collab-rooms";
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

/** The DOCX the room's authority reads revision 0 from, as base64. */
const readSeedDocxBase64 = async (
  room: FolioCollabSnapshotTarget,
): Promise<Result<string, HandlerError>> => {
  const seedDocx = await readFolioCollabSeedDocx(room);
  if (seedDocx === null) {
    return Result.err(
      new HandlerError({
        code: "folio_collab_seed_unavailable",
        status: 409,
        message: "Collaborative room source file is no longer available.",
      }),
    );
  }
  return Result.ok(Buffer.from(seedDocx).toBase64());
};

const loadFolioCollabSnapshotHandler = createSafeTokenHandler(
  config,
  verifyFolioCollabServiceCaller,
  async function* ({ body }) {
    const value = yield* Result.await(
      resolveFolioCollabServiceRoom(body.roomId),
    );

    const stored = yield* Result.await(loadFolioCollabSnapshot(value));
    if (stored === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative editing room not found.",
        }),
      );
    }
    const { snapshot } = stored;
    const response: FolioCollabSnapshotLoadResponse =
      snapshot.loadOutcome === FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded
        ? {
            loadOutcome: snapshot.loadOutcome,
            generation: snapshot.generation,
            seedDocxBase64: yield* Result.await(readSeedDocxBase64(value)),
            snapshotBase64: snapshot.snapshotBase64,
            snapshotRevision: snapshot.snapshotRevision,
          }
        : snapshot;
    return Result.ok(response);
  },
);

export default loadFolioCollabSnapshotHandler;
