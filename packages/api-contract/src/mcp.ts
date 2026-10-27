/** Browser-safe path for the default MCP transport. */
export const MCP_HTTP_PATH = "/mcp" as const;
export const MCP_ADVANCED_HTTP_PATH = "/mcp/advanced" as const;
export const MCP_DOCUMENTS_HTTP_PATH = "/mcp-documents" as const;
export const MCP_ANONYMIZED_HTTP_PATH = "/mcp-anonymized" as const;
export const MCP_LAW_HTTP_PATH = "/mcp-law" as const;

export const ACCOUNT_EXPORT_SCOPES = {
  read: "stella:account_export_read",
  write: "stella:account_export_write",
} as const;

// Browser-safe literal; registry.test.ts compares both directions against
// every scope required by the tools served on /mcp.
export const MCP_DEFAULT_RESOURCE_SCOPES = [
  "stella:search",
  "stella:read",
  "stella:law_read",
  "stella:templates",
  "stella:documents_write",
  "stella:matters_write",
  "stella:contacts_write",
  "stella:knowledge_write",
  "stella:billing_write",
  "stella:admin_read",
  "stella:admin_write",
  "stella:onboarding",
  "stella:feedback",
] as const;

export const MCP_ADVANCED_RESOURCE_SCOPES = [
  "stella:search",
  "stella:read",
  "stella:law_read",
  "stella:templates",
  "stella:documents_write",
  "stella:matters_write",
  "stella:contacts_write",
  "stella:chat",
  "stella:memory_write",
  "stella:knowledge_write",
  "stella:billing_write",
  "stella:admin_read",
  "stella:admin_write",
  ACCOUNT_EXPORT_SCOPES.read,
  ACCOUNT_EXPORT_SCOPES.write,
  "stella:onboarding",
  "stella:skills",
  "stella:feedback",
  "stella:external_mcps",
] as const;

export type McpDefaultResourceScope =
  (typeof MCP_ADVANCED_RESOURCE_SCOPES)[number];

export const MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE = {
  "stella:search": "stella:search_anonymized",
  "stella:read": "stella:read_anonymized",
  "stella:law_read": "stella:read_anonymized",
  "stella:templates": "stella:templates_anonymized",
  "stella:documents_write": null,
  "stella:matters_write": null,
  "stella:contacts_write": null,
  "stella:chat": null,
  "stella:memory_write": null,
  "stella:knowledge_write": null,
  "stella:billing_write": null,
  "stella:admin_read": null,
  "stella:admin_write": null,
  "stella:account_export_read": null,
  "stella:account_export_write": null,
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

export const MCP_ANONYMIZED_RESOURCE_SCOPES = [
  ...new Set(
    Object.values(MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE).filter(
      isMcpAnonymizedResourceScope,
    ),
  ),
];

const MCP_RESOURCE_SCOPE_ACCESS = {
  "stella:search": "read-capable",
  "stella:read": "read-capable",
  "stella:law_read": "read-capable",
  "stella:templates": "read-capable",
  "stella:documents_write": "write-only",
  "stella:matters_write": "write-only",
  "stella:contacts_write": "write-only",
  "stella:chat": "read-capable",
  "stella:memory_write": "write-only",
  "stella:knowledge_write": "write-only",
  "stella:billing_write": "write-only",
  "stella:admin_read": "read-capable",
  "stella:admin_write": "write-only",
  "stella:account_export_read": "read-capable",
  "stella:account_export_write": "write-only",
  "stella:onboarding": "read-capable",
  "stella:skills": "read-capable",
  "stella:external_mcps": "read-capable",
  "stella:feedback": "read-capable",
} as const satisfies Record<
  McpDefaultResourceScope,
  "read-capable" | "write-only"
>;

export type McpWriteOnlyResourceScope = {
  [
    TScope in McpDefaultResourceScope
  ]: (typeof MCP_RESOURCE_SCOPE_ACCESS)[TScope] extends "write-only"
    ? TScope
    : never;
}[McpDefaultResourceScope];

const isMcpWriteOnlyResourceScope = (
  scope: McpDefaultResourceScope,
): scope is McpWriteOnlyResourceScope =>
  MCP_RESOURCE_SCOPE_ACCESS[scope] === "write-only";

export const MCP_WRITE_ONLY_RESOURCE_SCOPES =
  MCP_ADVANCED_RESOURCE_SCOPES.filter(isMcpWriteOnlyResourceScope);

export const MCP_OAUTH_PROTOCOL_SCOPES = [
  "openid",
  "profile",
  "email",
  // Protocol scope (RFC 6749 / OIDC), not a Stella resource scope. It must
  // never enter resource-metadata scope lists; granting it lets the OAuth
  // provider issue a refresh token alongside the access token.
  "offline_access",
] as const;

/**
 * Products the consent screen may brand. The server names one only when the
 * client's registered locations prove it; a client's own name never does.
 */
export const VERIFIED_OAUTH_CLIENT_BRANDS = [
  "stella",
  "claude",
  "claude_code",
  "chatgpt",
  "codex",
] as const;

export type VerifiedOAuthClientBrand =
  (typeof VERIFIED_OAUTH_CLIENT_BRANDS)[number];

/**
 * What the consent screen may claim about the client asking. A `verified`
 * client is named by its brand alone: its product name and mark come from
 * stella, never from its registration. A `verified_unbranded` client's
 * locations are all known but name no single product, such as a platform that
 * serves connectors anyone can publish. Any other client is `unverified`.
 * `name` is the client's registered name, shown only as its own claim.
 */
export type OAuthConsentClient =
  | { type: "verified"; brand: VerifiedOAuthClientBrand }
  | { type: "verified_unbranded"; name: string | null }
  | { type: "unverified"; name: string | null };

export type McpOAuthScope =
  | (typeof MCP_OAUTH_PROTOCOL_SCOPES)[number]
  | McpDefaultResourceScope
  | McpAnonymizedResourceScope;
