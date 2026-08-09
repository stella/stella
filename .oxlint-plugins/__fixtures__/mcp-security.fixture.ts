// Passive regression fixture for both `mcp-security` rules.

declare const db: {
  innerJoin: (table: unknown, predicate: unknown) => unknown;
  leftJoin: (table: unknown, predicate: unknown) => unknown;
};
declare const mcpOAuthClients: unknown;
declare const organizations: unknown;
declare const predicate: unknown;
declare const redactMcpOAuthRegistrationResponse: (value: unknown) => unknown;
declare const registrationResponse: unknown;

export const unsafePersistence = {
  // MUST flag: raw DCR responses can contain client credentials.
  // oxlint-disable-next-line mcp-security/redact-oauth-registration-response -- fixture: registrationResponse must be redacted before persistence
  registrationResponse,
};

// Allowed: the canonical redactor owns the persistence boundary.
export const safePersistence = {
  registrationResponse:
    redactMcpOAuthRegistrationResponse(registrationResponse),
};

// MUST flag: direct OAuth client joins bypass the typed connection loader.
// oxlint-disable-next-line mcp-security/no-direct-oauth-client-join -- fixture: MCP OAuth joins must stay behind the typed loader
export const directOAuthJoin = db.leftJoin(mcpOAuthClients, predicate);

// MUST flag: inner joins carry the same row-normalization risk.
// oxlint-disable-next-line mcp-security/no-direct-oauth-client-join -- fixture: both supported Drizzle join shapes are protected
export const directOAuthInnerJoin = db.innerJoin(mcpOAuthClients, predicate);

// Allowed: joins to unrelated tables are outside the MCP invariant.
export const organizationJoin = db.leftJoin(organizations, predicate);
