import type { OAuthClaimExtensionInput } from "@better-auth/oauth-provider";
import { Result, TaggedError } from "better-result";
import type { JWTPayload } from "jose";

import { readServiceOAuthClientBinding } from "@/api/db/root";

import {
  SERVICE_CLIENT_PRINCIPAL,
  SERVICE_CLIENT_PRINCIPAL_CLAIM,
  SERVICE_CLIENT_SCOPES,
  SERVICE_CLIENT_TYPE,
  SERVICE_CLIENT_VERSION_CLAIM,
  servicePrincipalFromClaims,
} from "./service-client-policy";
import type { ServiceOAuthPrincipal } from "./service-client-policy";

class ServiceClientUnavailableError extends TaggedError(
  "ServiceClientUnavailableError",
)<{ message: string }> {}

export const readServiceOAuthClient = async (clientId: string) => {
  const client = await readServiceOAuthClientBinding(clientId);
  if (
    !client ||
    client.organizationId === null ||
    client.requestsPerMinute === null ||
    client.dailyBudget === null ||
    client.credentialVersion === null
  ) {
    return null;
  }
  return {
    clientId: client.clientId,
    organizationId: client.organizationId,
    disabled: client.disabled,
    type: client.type,
    userId: client.userId,
    clientCredentialsScopes: client.clientCredentialsScopes,
    requestsPerMinute: client.requestsPerMinute,
    dailyBudget: client.dailyBudget,
    credentialVersion: client.credentialVersion,
    clientSecret: client.clientSecret,
  };
};

export const getServiceOAuthClaims = async ({
  client,
  user,
  scopes,
  grantType,
}: OAuthClaimExtensionInput) => {
  const binding = await readServiceOAuthClientBinding(client.clientId);
  if (binding?.type !== SERVICE_CLIENT_TYPE) {
    return Result.ok({});
  }
  if (
    binding.organizationId === null ||
    binding.credentialVersion === null ||
    binding.disabled ||
    binding.userId !== null ||
    binding.clientSecret !== client.clientSecret ||
    client.grantTypes?.length !== 1 ||
    client.grantTypes.at(0) !== "client_credentials" ||
    user ||
    // Opaque-token introspection re-derives claims without a grantType.
    (grantType !== undefined && grantType !== "client_credentials") ||
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        !SERVICE_CLIENT_SCOPES.some((allowed) => allowed === scope) ||
        !binding.clientCredentialsScopes.includes(scope),
    )
  ) {
    return Result.err(
      new ServiceClientUnavailableError({
        message: "Service client is unavailable",
      }),
    );
  }
  return Result.ok({
    org_id: binding.organizationId,
    [SERVICE_CLIENT_PRINCIPAL_CLAIM]: SERVICE_CLIENT_PRINCIPAL,
    [SERVICE_CLIENT_VERSION_CLAIM]: binding.credentialVersion,
  });
};

/** Called after signature, issuer and law-audience verification, on every request. */
export const resolveServiceOAuthToken = async (
  payload: JWTPayload,
): Promise<ServiceOAuthPrincipal | null> => {
  const clientId = payload["client_id"];
  if (
    typeof clientId !== "string" ||
    payload[SERVICE_CLIENT_PRINCIPAL_CLAIM] !== SERVICE_CLIENT_PRINCIPAL
  ) {
    return null;
  }
  const binding = await readServiceOAuthClient(clientId);
  return binding ? servicePrincipalFromClaims(payload, binding) : null;
};
