import type { McpSession } from "@/api/mcp/auth";

/** Shared by the schema, persistence and the token boundary; loads no auth runtime. */
export const SERVICE_CLIENT_BUDGET_CEILINGS = {
  requestsPerMinute: 600,
  dailyBudget: 100_000,
} as const;

export const SERVICE_CLIENT_SCOPES = ["stella:law_read"] as const;
export const SERVICE_CLIENT_PRINCIPAL_CLAIM = "stella_principal";
export const SERVICE_CLIENT_PRINCIPAL = "service";
export const SERVICE_CLIENT_VERSION_CLAIM = "stella_client_version";
export const SERVICE_CLIENT_TYPE = "service";

export type ServiceOAuthPrincipal = {
  type: "service";
  clientId: string;
  organizationId: string;
  scopes: (typeof SERVICE_CLIENT_SCOPES)[number][];
  requestsPerMinute: number;
  dailyBudget: number;
};

export type ServiceClientBinding = {
  credentialVersion: number;
  clientId: string;
  organizationId: string;
  disabled: boolean;
  type: string | null;
  userId: string | null;
  clientCredentialsScopes: string[];
  requestsPerMinute: number;
  dailyBudget: number;
};

/** Service principals exist only at this public-law boundary. */
export type LegalResolveSession = McpSession | ServiceOAuthPrincipal;

export const isServiceResolveSession = (
  session: LegalResolveSession,
): session is ServiceOAuthPrincipal => "type" in session;
