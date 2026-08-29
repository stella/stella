/** Browser-safe path for the default MCP transport. */
export const MCP_HTTP_PATH = "/mcp" as const;
export const MCP_DOCUMENTS_HTTP_PATH = "/mcp-documents" as const;
export const MCP_ANONYMIZED_HTTP_PATH = "/mcp-anonymized" as const;

export const MCP_DEFAULT_RESOURCE_SCOPES = [
  "stella:search",
  "stella:read",
  "stella:templates",
  "stella:documents_write",
  "stella:matters_write",
  "stella:contacts_write",
  "stella:chat",
  "stella:knowledge_write",
  "stella:billing_write",
  "stella:admin_read",
  "stella:admin_write",
  "stella:onboarding",
  "stella:skills",
  "stella:external_mcps",
  "stella:feedback",
] as const;

export type McpDefaultResourceScope =
  (typeof MCP_DEFAULT_RESOURCE_SCOPES)[number];

export const MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE = {
  "stella:search": "stella:search_anonymized",
  "stella:read": "stella:read_anonymized",
  "stella:templates": "stella:templates_anonymized",
  "stella:documents_write": null,
  "stella:matters_write": null,
  "stella:contacts_write": null,
  "stella:chat": null,
  "stella:knowledge_write": null,
  "stella:billing_write": null,
  "stella:admin_read": null,
  "stella:admin_write": null,
  "stella:onboarding": null,
  "stella:skills": null,
  "stella:external_mcps": null,
  "stella:feedback": null,
} as const satisfies Record<
  McpDefaultResourceScope,
  `stella:${string}_anonymized` | null
>;

export type McpAnonymizedResourceScope = Exclude<
  (typeof MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE)[McpDefaultResourceScope],
  null
>;

const isMcpAnonymizedResourceScope = (
  scope: McpAnonymizedResourceScope | null,
): scope is McpAnonymizedResourceScope => scope !== null;

export const MCP_ANONYMIZED_RESOURCE_SCOPES = Object.values(
  MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE,
).filter(isMcpAnonymizedResourceScope);

const MCP_RESOURCE_SCOPE_ACCESS = {
  "stella:search": "read-capable",
  "stella:read": "read-capable",
  "stella:templates": "read-capable",
  "stella:documents_write": "write-only",
  "stella:matters_write": "write-only",
  "stella:contacts_write": "write-only",
  "stella:chat": "read-capable",
  "stella:knowledge_write": "write-only",
  "stella:billing_write": "write-only",
  "stella:admin_read": "read-capable",
  "stella:admin_write": "write-only",
  "stella:onboarding": "read-capable",
  "stella:skills": "read-capable",
  "stella:external_mcps": "read-capable",
  "stella:feedback": "read-capable",
} as const satisfies Record<
  McpDefaultResourceScope,
  "read-capable" | "write-only"
>;

export type McpWriteOnlyResourceScope = {
  [TScope in McpDefaultResourceScope]: (typeof MCP_RESOURCE_SCOPE_ACCESS)[TScope] extends "write-only"
    ? TScope
    : never;
}[McpDefaultResourceScope];

const isMcpWriteOnlyResourceScope = (
  scope: McpDefaultResourceScope,
): scope is McpWriteOnlyResourceScope =>
  MCP_RESOURCE_SCOPE_ACCESS[scope] === "write-only";

export const MCP_WRITE_ONLY_RESOURCE_SCOPES =
  MCP_DEFAULT_RESOURCE_SCOPES.filter(isMcpWriteOnlyResourceScope);

export const MCP_OAUTH_PROTOCOL_SCOPES = [
  "openid",
  "profile",
  "email",
  // Protocol scope (RFC 6749 / OIDC), not a Stella resource scope. It must
  // never enter resource-metadata scope lists; granting it lets the OAuth
  // provider issue a refresh token alongside the access token.
  "offline_access",
] as const;

export type McpOAuthScope =
  | (typeof MCP_OAUTH_PROTOCOL_SCOPES)[number]
  | McpDefaultResourceScope
  | McpAnonymizedResourceScope;
