import {
  AGENT_AUTH_ASSERTION_TYPES,
  AGENT_AUTH_CLAIM_PATH,
  AGENT_AUTH_EVENTS_PATH,
  AGENT_AUTH_EVENTS_SUPPORTED,
  AGENT_AUTH_IDENTITY_PATH,
  AGENT_AUTH_IDENTITY_TYPES,
  getAgentAuthManifestUrl,
  getAgentAuthUrl,
} from "@/api/agent-auth/constants";
import { env } from "@/api/env";

/**
 * The `agent_auth` profile block merged onto our RFC 8414 authorization
 * server metadata. This is the bootstrap surface agents read after the
 * two-hop discovery to learn our registration endpoints and the identity
 * types / assertion types we accept.
 *
 * The ID-JAG `identity_assertion` flow is dark-launched: the identity
 * endpoint 403s it while `FEATURE_AGENT_ID_JAG` is off. Gate the advertised
 * type/assertion lists on the same flag so discovery never offers a path we
 * would reject — an agent that picks it from discovery must be able to use it.
 */
export const getAgentAuthMetadataBlock = () => {
  const idJagEnabled = env.FEATURE_AGENT_ID_JAG;
  return {
    skill: getAgentAuthManifestUrl(),
    identity_endpoint: getAgentAuthUrl(AGENT_AUTH_IDENTITY_PATH),
    claim_endpoint: getAgentAuthUrl(AGENT_AUTH_CLAIM_PATH),
    events_endpoint: getAgentAuthUrl(AGENT_AUTH_EVENTS_PATH),
    identity_types_supported: AGENT_AUTH_IDENTITY_TYPES.filter(
      (type) => idJagEnabled || type !== "identity_assertion",
    ),
    identity_assertion: {
      assertion_types_supported: idJagEnabled
        ? [...AGENT_AUTH_ASSERTION_TYPES]
        : [],
    },
    events_supported: [...AGENT_AUTH_EVENTS_SUPPORTED],
  };
};
