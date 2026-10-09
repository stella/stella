import type { JWTPayload } from "jose";

export const SERVICE_CLIENT_SCOPES = ["stella:law_read"] as const;
export const SERVICE_CLIENT_PRINCIPAL_CLAIM = "stella_principal";
export const SERVICE_CLIENT_PRINCIPAL = "service";
export const SERVICE_CLIENT_VERSION_CLAIM = "stella_client_version";
export const SERVICE_CLIENT_TYPE = "service";

export type ServiceOAuthPrincipal = {
  type: "service";
  clientId: string;
  organizationId: string;
  scopes: string[];
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

/** The provider supplies the client subject; it is never a human identity. */
export const servicePrincipalFromClaims = (
  payload: JWTPayload,
  client: ServiceClientBinding,
): ServiceOAuthPrincipal | null => {
  const scope = payload["scope"];
  const scopes =
    typeof scope === "string" ? scope.split(" ").filter(Boolean) : [];
  if (
    payload[SERVICE_CLIENT_PRINCIPAL_CLAIM] !== SERVICE_CLIENT_PRINCIPAL ||
    payload.sub !== client.clientId ||
    payload["client_id"] !== client.clientId ||
    payload["org_id"] !== client.organizationId ||
    payload[SERVICE_CLIENT_VERSION_CLAIM] !== client.credentialVersion ||
    client.disabled ||
    client.type !== SERVICE_CLIENT_TYPE ||
    client.userId !== null ||
    scopes.length === 0 ||
    scopes.some(
      (value) =>
        !SERVICE_CLIENT_SCOPES.some((allowed) => allowed === value) ||
        !client.clientCredentialsScopes.includes(value),
    )
  ) {
    return null;
  }
  return {
    type: "service",
    clientId: client.clientId,
    organizationId: client.organizationId,
    scopes,
    requestsPerMinute: client.requestsPerMinute,
    dailyBudget: client.dailyBudget,
  };
};
