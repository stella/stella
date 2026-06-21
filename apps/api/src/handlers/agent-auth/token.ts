import { Result } from "better-result";
import { t } from "elysia";

import {
  AGENT_AUTH_CLAIM_GRANT_TYPE,
  AGENT_AUTH_JWT_BEARER_GRANT_TYPE,
} from "@/api/agent-auth/constants";
import { env } from "@/api/env";
import {
  exchangeAuthorizationCode,
  pollClaimGrant,
} from "@/api/lib/agent-auth";
import type {
  AgentTokenErrorCode,
  TokenResponseShape,
} from "@/api/lib/agent-auth";
import {
  loadIdJagExchangeContext,
  verifyServiceAssertion,
} from "@/api/lib/agent-auth-idjag";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Profile-specific token exchange hosting two grants better-auth's closed
 * GrantType union cannot: the claim-grant poll (service_auth / anonymous
 * claim) and the RFC 7523 jwt-bearer grant (ID-JAG). The grant_type is a
 * closed union so an unsupported grant fails schema validation.
 */
const config = {
  body: t.Union([
    t.Object({
      grant_type: t.Literal(AGENT_AUTH_CLAIM_GRANT_TYPE),
      claim_token: t.String({ minLength: 1, maxLength: 256 }),
    }),
    t.Object({
      grant_type: t.Literal(AGENT_AUTH_JWT_BEARER_GRANT_TYPE),
      assertion: t.String({ minLength: 1, maxLength: 8192 }),
    }),
  ]),
} satisfies PublicHandlerConfig;

const ERROR_STATUS_BY_CODE: Record<AgentTokenErrorCode, 400 | 403> = {
  authorization_pending: 400,
  slow_down: 400,
  expired_token: 400,
  access_denied: 403,
  invalid_grant: 400,
  token_mint_failed: 400,
};

const toHandlerError = (code: AgentTokenErrorCode): HandlerError =>
  new HandlerError({ status: ERROR_STATUS_BY_CODE[code], message: code });

const toTokenResult = (
  result: Result<TokenResponseShape, { code: AgentTokenErrorCode }>,
): Result<TokenResponseShape, HandlerError> => {
  if (Result.isError(result)) {
    return Result.err(toHandlerError(result.error.code));
  }
  return Result.ok(result.value);
};

/**
 * RFC 7523 jwt-bearer exchange for an ID-JAG agent: verify our own
 * service-issued intermediate assertion, resolve its `sub` to the bound
 * registration, and exchange the one-shot authorization code for an
 * MCP-audience JWT. Gated by the same dark-launch flag as the identity
 * endpoint so the grant fails closed when the feature is off.
 */
const exchangeJwtBearer = async (
  assertion: string,
): Promise<Result<TokenResponseShape, HandlerError>> => {
  if (!env.FEATURE_AGENT_ID_JAG) {
    return Result.err(
      new HandlerError({ status: 400, message: "invalid_grant" }),
    );
  }

  const subResult = await verifyServiceAssertion(assertion);
  if (Result.isError(subResult)) {
    return Result.err(toHandlerError(subResult.error.code));
  }

  const contextResult = await loadIdJagExchangeContext(subResult.value);
  if (Result.isError(contextResult)) {
    return Result.err(toHandlerError(contextResult.error.code));
  }

  const exchange = await exchangeAuthorizationCode({
    clientId: contextResult.value.clientId,
    clientSecret: contextResult.value.clientSecret,
    code: contextResult.value.authorizationCode,
    resourceMode: "default",
  });
  return toTokenResult(exchange);
};

const agentTokenHandler = createSafePublicHandler(
  config,
  // eslint-disable-next-line require-yield -- control-plane writes go through rootDb (RLS-bypassing), so there is no safeDb to Result.await
  async function* ({ body }) {
    const result =
      body.grant_type === AGENT_AUTH_JWT_BEARER_GRANT_TYPE
        ? await exchangeJwtBearer(body.assertion)
        : toTokenResult(await pollClaimGrant(body.claim_token));

    if (Result.isError(result)) {
      return Result.err(result.error);
    }

    const token = result.value;
    return Result.ok({
      access_token: token.access_token,
      token_type: token.token_type,
      expires_in: token.expires_in,
      scope: token.scope,
    });
  },
);

export default agentTokenHandler;
