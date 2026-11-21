import type { JWTPayload } from "jose";

import {
  SERVICE_CLIENT_PRINCIPAL,
  SERVICE_CLIENT_PRINCIPAL_CLAIM,
  SERVICE_CLIENT_SCOPES,
  SERVICE_CLIENT_TYPE,
  SERVICE_CLIENT_VERSION_CLAIM,
} from "@/api/lib/db/service-client-contract";
import type {
  ServiceClientBinding,
  ServiceOAuthPrincipal,
} from "@/api/lib/db/service-client-contract";

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
    scopes: SERVICE_CLIENT_SCOPES.filter((allowed) => scopes.includes(allowed)),
    requestsPerMinute: client.requestsPerMinute,
    dailyBudget: client.dailyBudget,
  };
};
