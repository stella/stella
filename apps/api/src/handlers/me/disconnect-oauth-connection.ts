import { Result } from "better-result";
import * as v from "valibot";

import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { disconnectOAuthConnectionForUser } from "@/api/lib/oauth-connections";

const routeParams = v.object({
  consentId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "auth_plumbing" },
  params: routeParams,
} satisfies SessionHandlerConfig;

const disconnectOAuthConnection = createSafeSessionHandler(
  config,
  async function* (ctx) {
    const disconnected = yield* Result.await(
      disconnectOAuthConnectionForUser({
        consentId: ctx.params.consentId,
        request: ctx.request,
        userId: ctx.user.id,
      }),
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
