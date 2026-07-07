import { Result } from "better-result";
import { t } from "elysia";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { disconnectOAuthConnectionForUser } from "@/api/lib/oauth-connections";

const routeParams = t.Object({
  // better-auth generates its own OAuth consent ids (not a stella `SafeId`),
  // so this is a plain bounded string rather than `tSafeId`.
  consentId: t.String({ minLength: 1, maxLength: 128 }),
});

const config = {
  mcp: { type: "internal", reason: "auth_plumbing" },
  params: routeParams,
} satisfies SessionHandlerConfig;

const disconnectOAuthConnection = createSafeSessionHandler(
  config,
  async function* (ctx) {
    const disconnected = yield* Result.await(
      disconnectOAuthConnectionForUser(ctx.user.id, ctx.params.consentId),
    );

    if (!disconnected) {
      return Result.err(
        new HandlerError({ status: 404, message: "Connection not found" }),
      );
    }

    return Result.ok(disconnected);
  },
);

export default disconnectOAuthConnection;
