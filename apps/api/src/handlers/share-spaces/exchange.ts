import { Result } from "better-result";
import { t } from "elysia";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { exchangeActiveShareInvitation } from "@/api/lib/share-space-access";

const config = {
  body: t.Object({
    invitationSecret: t.String({ minLength: 43, maxLength: 43 }),
  }),
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies SessionHandlerConfig;

const exchangeShareInvitation = createSafeSessionHandler(
  config,
  async function* ({ body, user, request, server }) {
    const exchange = yield* Result.await(
      Result.tryPromise(
        async () =>
          await exchangeActiveShareInvitation({
            invitationSecret: body.invitationSecret,
            email: user.email,
            userId: user.id,
            request,
            server: server ?? null,
          }),
      ),
    );

    if (!exchange) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Share link is not available.",
        }),
      );
    }
    return Result.ok(exchange);
  },
);

export default exchangeShareInvitation;
