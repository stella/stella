import { panic, Result } from "better-result";
import { t } from "elysia";

import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { acknowledgeFolioCollabSeed } from "@/api/lib/folio-collab-rooms";
import {
  permissiveBodySchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";

import { authorizeFolioCollabCredentials } from "./room-credentials";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: permissiveBodySchema({
    keys: ["roomId", "token", "snapshotSha256Hex"],
  }),
} satisfies TokenHandlerConfig;

const seedReceiptSchema = t.Object({
  snapshotSha256Hex: t.String({ pattern: "^[0-9a-f]{64}$" }),
});

const acknowledgeSeed = createSafeTokenHandler(
  config,
  async function* ({ body }) {
    const { room } = yield* Result.await(authorizeFolioCollabCredentials(body));
    const receipt = validatePostAuth(seedReceiptSchema, body);
    if (!receipt.ok) {
      return Result.err(
        new HandlerError({ status: 422, message: receipt.message }),
      );
    }
    const acknowledged = yield* Result.await(
      acknowledgeFolioCollabSeed({
        value: room,
        snapshotSha256Hex: receipt.value.snapshotSha256Hex,
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

declareAggregateMutation(acknowledgeSeed.handler, {
  type: "aggregate",
  aggregates: ["workspace", "folioCollabRoom"],
});

export default acknowledgeSeed;
