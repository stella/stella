import { getAuth } from "@/api/lib/auth";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getMcpResourceUrl,
  MCP_OAUTH_SCOPES,
  type McpOAuthScope,
} from "@/api/mcp/constants";

/**
 * The credential an agent-sandbox run presents to the stella MCP server (plan
 * 050). It is a delegated, user-attributed, least-privilege, short-lived token
 * — semantically RFC 8693 token exchange: the run acts ON BEHALF OF the user
 * (`sub` carries the user id, so every tool call audits back to a person), with
 * an attenuated `scope` (a strict subset of what a person can do), a short
 * `exp`, and a `run_id` for audit correlation.
 *
 * It is signed by the same key the MCP server already verifies via JWKS, so the
 * MCP verification path (`authenticateMcpRequest`) accepts it UNCHANGED — no
 * second auth path, no new attack surface on the verifier.
 *
 * Signing goes through `auth.api.signJWT`, a server-only better-auth endpoint
 * (never reachable over HTTP), so minting happens only where the API has
 * already authenticated the user and computed the scope.
 */

/**
 * Least-privilege default scope for an agent run: read/search + the write
 * surfaces a legal agent legitimately needs, but NOT admin, billing, or
 * onboarding. The minting boundary always applies this fixed set; the pure
 * claim builder accepts a narrower set so attenuation remains testable and can
 * be introduced deliberately with a typed run profile later.
 */
const AGENT_RUN_SCOPE_DISPOSITION = {
  openid: "excluded",
  profile: "excluded",
  email: "excluded",
  offline_access: "excluded",
  "stella:search": "default",
  "stella:read": "default",
  "stella:templates": "default",
  "stella:documents_write": "default",
  "stella:matters_write": "default",
  "stella:contacts_write": "excluded",
  "stella:chat": "default",
  "stella:knowledge_write": "default",
  "stella:billing_write": "excluded",
  "stella:admin_read": "excluded",
  "stella:admin_write": "excluded",
  "stella:onboarding": "excluded",
  "stella:skills": "default",
  "stella:external_mcps": "excluded",
  "stella:feedback": "excluded",
  "stella:search_anonymized": "excluded",
  "stella:read_anonymized": "excluded",
  "stella:templates_anonymized": "excluded",
} as const satisfies Record<McpOAuthScope, "default" | "excluded">;

type AgentRunDefaultScope = {
  [TScope in McpOAuthScope]: (typeof AGENT_RUN_SCOPE_DISPOSITION)[TScope] extends "default"
    ? TScope
    : never;
}[McpOAuthScope];

const isAgentRunDefaultScope = (
  scope: McpOAuthScope,
): scope is AgentRunDefaultScope =>
  AGENT_RUN_SCOPE_DISPOSITION[scope] === "default";

export const AGENT_RUN_DEFAULT_SCOPES = MCP_OAUTH_SCOPES.filter(
  isAgentRunDefaultScope,
);

/** Agent-run tokens are short-lived: a run should outlive its token rarely. */
export const AGENT_RUN_TOKEN_TTL_SECONDS = 15 * 60;
export const AGENT_RUN_TOKEN_PURPOSE = "agent-run" as const;

export type AgentRunTokenClaims = {
  sub: string;
  org_id: string;
  scope: string;
  aud: string;
  iss: string;
  iat: number;
  exp: number;
  run_id: string;
  workspace_ids: string[];
  purpose: typeof AGENT_RUN_TOKEN_PURPOSE;
};

type BuildAgentRunTokenClaimsInput = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  runId: string;
  workspaceIds: readonly SafeId<"workspace">[];
  scopes: readonly McpOAuthScope[];
  audience: string;
  issuer: string;
  nowSeconds: number;
  ttlSeconds: number;
};

/**
 * Pure claim builder — no env, no signing — so the token shape is unit
 * testable. `mintAgentRunToken` supplies audience/issuer/time and signs.
 */
export const buildAgentRunTokenClaims = ({
  userId,
  organizationId,
  runId,
  workspaceIds,
  scopes,
  audience,
  issuer,
  nowSeconds,
  ttlSeconds,
}: BuildAgentRunTokenClaimsInput): AgentRunTokenClaims => ({
  sub: userId,
  org_id: organizationId,
  scope: scopes.join(" "),
  aud: audience,
  iss: issuer,
  iat: nowSeconds,
  exp: nowSeconds + ttlSeconds,
  run_id: runId,
  workspace_ids: [...workspaceIds],
  purpose: AGENT_RUN_TOKEN_PURPOSE,
});

export type MintAgentRunTokenInput = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  runId: string;
  /** Server-authorized workspace subset this run may access. */
  workspaceIds: readonly SafeId<"workspace">[];
};

export type MintedAgentRunToken = {
  token: string;
  expiresAt: Date;
};

export const mintAgentRunToken = async (
  input: MintAgentRunTokenInput,
): Promise<MintedAgentRunToken> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = buildAgentRunTokenClaims({
    userId: input.userId,
    organizationId: input.organizationId,
    runId: input.runId,
    workspaceIds: input.workspaceIds,
    scopes: AGENT_RUN_DEFAULT_SCOPES,
    audience: getMcpResourceUrl(),
    issuer: getAuthIssuerUrl(),
    nowSeconds,
    ttlSeconds: AGENT_RUN_TOKEN_TTL_SECONDS,
  });
  const { token } = await getAuth().api.signJWT({ body: { payload: claims } });
  return {
    token,
    expiresAt: new Date((nowSeconds + AGENT_RUN_TOKEN_TTL_SECONDS) * 1000),
  };
};
