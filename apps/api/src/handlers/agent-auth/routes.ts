import Elysia from "elysia";

import {
  AGENT_AUTH_CLAIM_PATH,
  AGENT_AUTH_CONFIRM_PATH,
  AGENT_AUTH_EVENTS_PATH,
  AGENT_AUTH_IDENTITY_PATH,
  AGENT_AUTH_MANIFEST_PATH,
  AGENT_AUTH_TOKEN_PATH,
} from "@/api/agent-auth/constants";
import { getAgentAuthManifest } from "@/api/agent-auth/manifest";
import agentClaimHandler from "@/api/handlers/agent-auth/claim";
import agentConfirmHandler from "@/api/handlers/agent-auth/confirm";
import agentEventsHandler from "@/api/handlers/agent-auth/events";
import agentIdentityHandler from "@/api/handlers/agent-auth/identity";
import agentTokenHandler from "@/api/handlers/agent-auth/token";
import { authMacro } from "@/api/lib/auth";

const MANIFEST_HEADERS: Record<string, string> = {
  "Content-Type": "text/markdown; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=300",
};

const applyManifestHeaders = (set: {
  headers: Record<string, string | number | boolean | undefined>;
}) => {
  for (const [key, value] of Object.entries(MANIFEST_HEADERS)) {
    set.headers[key] = value;
  }
};

/**
 * Pre-auth agent-auth surface: the skill manifest plus the registration,
 * claim, claim-grant-poll, and SET-receiver endpoints. These are
 * unauthenticated and pollable, so index.ts wraps this route in the
 * dedicated `agentAuth` rate-limit bucket.
 */
export const agentAuthRoute = new Elysia()
  .options(AGENT_AUTH_MANIFEST_PATH, ({ set }) => {
    applyManifestHeaders(set);
    set.status = 204;
    return "";
  })
  .get(AGENT_AUTH_MANIFEST_PATH, ({ set }) => {
    applyManifestHeaders(set);
    return getAgentAuthManifest();
  })
  .post(
    AGENT_AUTH_IDENTITY_PATH,
    agentIdentityHandler.handler,
    agentIdentityHandler.config,
  )
  .post(
    AGENT_AUTH_CLAIM_PATH,
    agentClaimHandler.handler,
    agentClaimHandler.config,
  )
  .post(
    AGENT_AUTH_TOKEN_PATH,
    agentTokenHandler.handler,
    agentTokenHandler.config,
  )
  .post(
    AGENT_AUTH_EVENTS_PATH,
    (ctx) => {
      // RFC 8935: a SET receiver acknowledges with 202 Accepted.
      ctx.set.status = 202;
      return agentEventsHandler.handler(ctx);
    },
    agentEventsHandler.config,
  );

/**
 * Session-authenticated confirm endpoint the web claim page calls. Kept
 * on its own route so the unauthenticated surface above is not gated by
 * the auth macro.
 */
export const agentAuthConfirmRoute = new Elysia()
  .use(authMacro)
  .guard({ validateAuth: true })
  .post(AGENT_AUTH_CONFIRM_PATH, agentConfirmHandler.handler, {
    body: agentConfirmHandler.config.body,
    permissions: agentConfirmHandler.config.permissions,
  });
