import {
  AGENT_AUTH_CLAIM_PATH,
  AGENT_AUTH_EVENTS_PATH,
  AGENT_AUTH_IDENTITY_PATH,
  AGENT_AUTH_TOKEN_PATH,
  AUTH_MD_SPEC_VERSION,
  getAgentAuthUrl,
} from "@/api/agent-auth/constants";
import { env } from "@/api/env";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  getMcpProtectedResourceMetadataUrl,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
} from "@/api/mcp/constants";

/**
 * The skill manifest served at /auth.md. It mirrors the upstream AUTH.md
 * shape but is stella-specific: it points agents at our live discovery
 * documents and states which identity types and scopes we accept. URLs are
 * resolved from the running environment so the document is correct in every
 * deployment.
 */
export const getAgentAuthManifest = (): string => {
  // ID-JAG is dark-launched: when the flag is off the AS metadata hides
  // `identity_assertion` and the identity route 403s it, so the manifest
  // must not advertise it either or agents discover an unsupported flow.
  const identityAssertionListItem = env.FEATURE_AGENT_ID_JAG
    ? `
- \`identity_assertion\` — present an audience-bound ID-JAG
  (\`urn:ietf:params:oauth:token-type:id-jag\`) signed by a trusted provider; exchange it
  via the RFC 7523 jwt-bearer grant.`
    : "";

  return `# stella — agent registration (auth.md)

stella implements the [auth.md](https://github.com/workos/auth.md) agent-registration
protocol (pinned to v${AUTH_MD_SPEC_VERSION}). An agent registers on a user's behalf and
receives a scoped, revocable OAuth access token.

## Discovery (two-hop)

1. Protected Resource Metadata: \`${getMcpProtectedResourceMetadataUrl()}\`
2. Authorization Server Metadata: \`${getAuthIssuerUrl()}/.well-known/oauth-authorization-server\`
   — read the \`agent_auth\` block for endpoints and supported flows.

## Identity types

- \`service_auth\` — supply the user's \`login_hint\` (email); a claim ceremony binds the
  agent once the user signs in and confirms a \`user_code\`. Poll the token endpoint with
  the claim grant to complete.
- \`anonymous\` — register with no user identity; receive a reduced-scope token limited to
  anonymized/public resources. Claimable by a user later.${identityAssertionListItem}

## Scopes

- Full: ${MCP_DEFAULT_RESOURCE_SCOPES.join(", ")}
- Anonymized: ${MCP_ANONYMIZED_RESOURCE_SCOPES.join(", ")}

## Endpoints

- identity: \`${getAgentAuthUrl(AGENT_AUTH_IDENTITY_PATH)}\`
- claim: \`${getAgentAuthUrl(AGENT_AUTH_CLAIM_PATH)}\`
- token: \`${getAgentAuthUrl(AGENT_AUTH_TOKEN_PATH)}\`
- events: \`${getAgentAuthUrl(AGENT_AUTH_EVENTS_PATH)}\`
`;
};
