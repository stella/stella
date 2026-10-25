import { Result } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import { startAnonymousUpgrade } from "@/api/lib/agent-auth";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import { normalizeEmail } from "@/api/lib/email/normalized-email";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  body: v.object({
    claim_token: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    email: v.pipe(v.string(), v.email(), v.maxLength(320)),
  }),
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
} satisfies PublicHandlerConfig;

const agentClaimHandler = createSafePublicHandler(
  config,
  async function* ({ body: { claim_token, email } }) {
    const result = await startAnonymousUpgrade({
      claimToken: claim_token,
      email: normalizeEmail(email),
    });

    // A bad/expired/non-anonymous claim token returns the same shape a
    // valid one would, so a caller cannot probe registration state.
    if (Result.isError(result)) {
      if (HandlerError.is(result.error)) {
        return Result.err(result.error);
      }
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
