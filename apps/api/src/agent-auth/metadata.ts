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

/**
 * The `agent_auth` profile block merged onto our RFC 8414 authorization
 * server metadata. This is the bootstrap surface agents read after the
 * two-hop discovery to learn our registration endpoints and the identity
 * types / assertion types we accept.
 */
export const getAgentAuthMetadataBlock = () => ({
  skill: getAgentAuthManifestUrl(),
  identity_endpoint: getAgentAuthUrl(AGENT_AUTH_IDENTITY_PATH),
  claim_endpoint: getAgentAuthUrl(AGENT_AUTH_CLAIM_PATH),
  events_endpoint: getAgentAuthUrl(AGENT_AUTH_EVENTS_PATH),
  identity_types_supported: [...AGENT_AUTH_IDENTITY_TYPES],
  identity_assertion: {
    assertion_types_supported: [...AGENT_AUTH_ASSERTION_TYPES],
  },
  events_supported: [...AGENT_AUTH_EVENTS_SUPPORTED],
});
