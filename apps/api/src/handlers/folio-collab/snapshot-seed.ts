import { panic, Result } from "better-result";
import * as v from "valibot";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { acknowledgeFolioCollabSeed } from "@/api/lib/folio-collab-rooms";

import {
  folioCollabRoomCredentialsSchema,
  verifyFolioCollabRoomCaller,
} from "./room-credentials";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: v.object({
    ...folioCollabRoomCredentialsSchema.entries,
    snapshotSha256Hex: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
  }),
} satisfies TokenHandlerConfig;

const acknowledgeSeed = createSafeTokenHandler(
  config,
  verifyFolioCollabRoomCaller,
  async function* ({ body, caller: { room } }) {
    const acknowledged = yield* Result.await(
      acknowledgeFolioCollabSeed({
        value: room,
        snapshotSha256Hex: body.snapshotSha256Hex,
      }),
    );
    switch (acknowledged.status) {
      case "access-revoked":
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Collaborative edit access revoked.",
          }),
        );
      case "seed-changed":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Collaborative room seed changed.",
          }),
        );
      case "acknowledged":
        return Result.ok({ generation: room.generation });
      default: {
        acknowledged satisfies never;
        return panic("Unhandled collaboration seed acknowledgement");
      }
    }
  },
);

declareAggregateMutation(acknowledgeSeed, {
  type: "aggregate",
  aggregates: ["workspace", "folioCollabRoom"],
});

export default acknowledgeSeed;
