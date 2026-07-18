import { Result } from "better-result";
import { t } from "elysia";

import { env } from "@/api/env";
import { startAnonymousUpgrade } from "@/api/lib/agent-auth";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  body: t.Object({
    claim_token: t.String({ minLength: 1, maxLength: 256 }),
    email: t.String({ format: "email", maxLength: 320 }),
  }),
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies PublicHandlerConfig;

const agentClaimHandler = createSafePublicHandler(
  config,
  async function* ({ body: { claim_token, email } }) {
    const result = await startAnonymousUpgrade({
      claimToken: claim_token,
      email: email.trim().toLowerCase(),
    });

    // A bad/expired/non-anonymous claim token returns the same shape a
    // valid one would, so a caller cannot probe registration state.
    if (Result.isError(result)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Could not start the claim ceremony.",
        }),
      );
    }

    const ceremony = result.value;
    // The user-facing page where the human enters the returned user_code to
    // finish the upgrade; without it a client cannot know where to send them.
    const verificationUri = `${env.FRONTEND_URL}/agent-claim`;
    return Result.ok({
      registration_id: ceremony.registrationId,
      registration_type: ceremony.registrationType,
      user_code: ceremony.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(ceremony.userCode)}`,
      expires_in: ceremony.expiresIn,
      interval: ceremony.interval,
      claim_token: ceremony.claimToken,
    });
  },
);

export default agentClaimHandler;
