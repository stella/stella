import {
  AGENT_AUTH_CLAIM_PATH,
  AGENT_AUTH_CONFIRM_PATH,
  AGENT_AUTH_EVENTS_PATH,
  AGENT_AUTH_IDENTITY_PATH,
  AGENT_AUTH_MANIFEST_PATH,
  AGENT_AUTH_TOKEN_PATH,
} from "@/api/agent-auth/constants";
import { AGENT_AUTH_MANIFEST_HEADERS } from "@/api/agent-auth/manifest";
import agentClaimHandler from "@/api/handlers/agent-auth/claim";
import agentConfirmHandler from "@/api/handlers/agent-auth/confirm";
import agentEventsHandler from "@/api/handlers/agent-auth/events";
import agentIdentityHandler from "@/api/handlers/agent-auth/identity";
import manifestHandler from "@/api/handlers/agent-auth/read-manifest";
import agentTokenHandler from "@/api/handlers/agent-auth/token";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { defineEndpoint } from "@/api/lib/endpoints";

/** The manifest's preflight: any origin may read the skill manifest. */
const manifestPreflight = defineEndpoint.public({ cors: "own" }, ({ set }) => {
  Object.assign(set.headers, AGENT_AUTH_MANIFEST_HEADERS);
  return status(204);
});

/**
 * Pre-auth agent-auth surface: the skill manifest plus the registration,
 * claim, claim-grant-poll, and SET-receiver endpoints. These are
 * unauthenticated and pollable, so the server mounts this table under the
 * dedicated `agentAuth` rate-limit bucket.
 */
export const agentAuthRoute = routes({
  [AGENT_AUTH_MANIFEST_PATH]: {
    GET: manifestHandler,
    OPTIONS: manifestPreflight,
  },
  [AGENT_AUTH_IDENTITY_PATH]: { POST: agentIdentityHandler },
  [AGENT_AUTH_CLAIM_PATH]: { POST: agentClaimHandler },
  [AGENT_AUTH_TOKEN_PATH]: { POST: agentTokenHandler },
  [AGENT_AUTH_EVENTS_PATH]: { POST: agentEventsHandler },
});

/**
 * Session-authenticated confirm endpoint the web claim page calls. Kept in
 * its own table so the server can mount it under its own abuse budget.
 */
export const agentAuthConfirmRoute = routes({
  [AGENT_AUTH_CONFIRM_PATH]: { POST: agentConfirmHandler },
});
