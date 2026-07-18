import { Result } from "better-result";
import { t } from "elysia";

import {
  AGENT_AUTH_CLAIM_PATH,
  AGENT_AUTH_ID_JAG_ASSERTION_TYPE,
  getAgentAuthUrl,
} from "@/api/agent-auth/constants";
import { env } from "@/api/env";
import {
  startAnonymousRegistration,
  startServiceAuthRegistration,
} from "@/api/lib/agent-auth";
import { resolveIdJagIdentity } from "@/api/lib/agent-auth-idjag";
import type { IdJagIdentityOutcome } from "@/api/lib/agent-auth-idjag";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";

/**
 * Body is a discriminated union on `type`. `identity_assertion` (ID-JAG)
 * is dark-launched behind `FEATURE_AGENT_ID_JAG` and gated on the
 * (empty-by-default) trusted-issuer allow-list.
 */
const config = {
  body: t.Union([
    t.Object({
      type: t.Literal("service_auth"),
      login_hint: t.Optional(t.String({ maxLength: 320 })),
    }),
    t.Object({
      type: t.Literal("anonymous"),
    }),
    t.Object({
      type: t.Literal("identity_assertion"),
      assertion_type: t.Literal(AGENT_AUTH_ID_JAG_ASSERTION_TYPE),
      assertion: t.String({ minLength: 1, maxLength: 8192 }),
    }),
  ]),
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies PublicHandlerConfig;

type AgentIdentityResponse =
  | {
      registration_id: string;
      registration_type: "anonymous";
      claim_token: string;
      access_token: string;
      token_type: "Bearer";
      expires_in: number;
      scope: string;
      claim_uri: string;
    }
  | {
      registration_id: string;
      registration_type: "service_auth";
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
      claim_token: string;
    }
  | {
      registration_id: string;
      registration_type: "identity_assertion";
      identity_assertion: string;
      assertion_expires: number;
      scopes: string[];
    };

// Widen both ceremony shapes to the union before constructing the Ok, so
// the safe-handler generator has a single return type. Returning
// `Result.ok(literal)` per branch infers two distinct `Ok` shapes that do
// not unify under exactOptionalPropertyTypes.
const okResponse = (response: AgentIdentityResponse) => Result.ok(response);

const getClaimVerificationUri = () => `${env.FRONTEND_URL}/agent-claim`;

const ID_JAG_REJECTION_STATUS = {
  issuer_not_enabled: 403,
  login_required: 401,
  invalid_assertion: 401,
} as const satisfies Record<string, HandlerErrorStatusCode>;

/**
 * Map an ID-JAG outcome to a safe-handler Result. `interaction_required`
 * carries the step-up claim block on a 401 so the agent can poll the
 * existing `/agent/token` claim grant once the human completes it; a clean
 * match returns the spec-shaped registration on a 200.
 */
const mapIdJagOutcome = (
  outcome: IdJagIdentityOutcome,
): Result<AgentIdentityResponse, HandlerError> => {
  if (outcome.kind === "ready") {
    const { result } = outcome;
    return okResponse({
      registration_id: result.registrationId,
      registration_type: result.registrationType,
      identity_assertion: result.identityAssertion,
      assertion_expires: result.assertionExpiresIn,
      scopes: [...result.scopes],
    });
  }

  if (outcome.kind === "interaction_required") {
    const { ceremony } = outcome;
    const verificationUri = getClaimVerificationUri();
    return Result.err(
      new HandlerError({
        status: 401,
        error: "interaction_required",
        message: "A human must link this agent to the existing account.",
        claim: {
          registration_id: ceremony.registrationId,
          user_code: ceremony.userCode,
          verification_uri: verificationUri,
          verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(ceremony.userCode)}`,
          expires_in: ceremony.expiresIn,
          interval: ceremony.interval,
          claim_token: ceremony.claimToken,
        },
      }),
    );
  }

  return Result.err(
    new HandlerError({
      status: ID_JAG_REJECTION_STATUS[outcome.error.code],
      error: outcome.error.code,
      message: outcome.error.message,
    }),
  );
};

const agentIdentityHandler = createSafePublicHandler(
  config,
  async function* ({ body }) {
    if (body.type === "identity_assertion") {
      // Dark-launch gate: even when on, the trusted-issuer allow-list
      // ships empty, so this still rejects every assertion until an
      // operator explicitly trusts an issuer.
      if (!env.FEATURE_AGENT_ID_JAG) {
        return Result.err(
          new HandlerError({
            status: 403,
            error: "issuer_not_enabled",
            message: "Identity-assertion registration is not enabled.",
          }),
        );
      }
      const outcome = await resolveIdJagIdentity(body.assertion);
      return mapIdJagOutcome(outcome);
    }

    if (body.type === "anonymous") {
      const result = await startAnonymousRegistration();
      if (Result.isError(result)) {
        return Result.err(
          new HandlerError({
            status: 502,
            message: "Could not issue an agent token.",
          }),
        );
      }

      const { registrationId, registrationType, claimToken, token } =
        result.value;
      return okResponse({
        registration_id: registrationId,
        registration_type: registrationType,
        claim_token: claimToken,
        access_token: token.access_token,
        token_type: token.token_type,
        expires_in: token.expires_in,
        scope: token.scope,
        // The public claim endpoint that upgrades this anonymous registration
        // (accepts claim_token + email), not the session-authed confirm route.
        claim_uri: getAgentAuthUrl(AGENT_AUTH_CLAIM_PATH),
      });
    }

    const loginHint = body.login_hint?.trim() ?? "";
    const ceremony = await startServiceAuthRegistration(
      loginHint.length > 0 ? loginHint : null,
    );

    const verificationUri = getClaimVerificationUri();
    const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(ceremony.userCode)}`;

    return okResponse({
      registration_id: ceremony.registrationId,
      registration_type: ceremony.registrationType,
      user_code: ceremony.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: ceremony.expiresIn,
      interval: ceremony.interval,
      claim_token: ceremony.claimToken,
    });
  },
);

export default agentIdentityHandler;
