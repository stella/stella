import type { OAuthClaimExtensionInput } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";
import type { JWTPayload } from "jose";

import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";

import { oauthClient } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { serviceOAuthClients } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";

import {
  SERVICE_CLIENT_PRINCIPAL,
  SERVICE_CLIENT_PRINCIPAL_CLAIM,
  SERVICE_CLIENT_SCOPES,
  SERVICE_CLIENT_TYPE,
  SERVICE_CLIENT_VERSION_CLAIM,
  servicePrincipalFromClaims,
} from "./service-client-policy";
import type { ServiceOAuthPrincipal } from "./service-client-policy";

/** Auth control-plane records are read by the owner connection, never scopedDb. */
export const readServiceOAuthClient = async (clientId: string) =>
  (
    await rootDb
      .select({
        clientId: oauthClient.clientId,
        organizationId: serviceOAuthClients.organizationId,
        disabled: oauthClient.disabled,
        type: oauthClient.type,
        userId: oauthClient.userId,
        clientCredentialsScopes: oauthClient.clientCredentialsScopes,
        requestsPerMinute: serviceOAuthClients.requestsPerMinute,
        dailyBudget: serviceOAuthClients.dailyBudget,
        credentialVersion: serviceOAuthClients.credentialVersion,
        clientSecret: oauthClient.clientSecret,
      })
      .from(serviceOAuthClients)
      .innerJoin(
        oauthClient,
        eq(oauthClient.clientId, serviceOAuthClients.clientId),
      )
      .where(eq(serviceOAuthClients.clientId, clientId))
      .limit(1)
  ).at(0) ?? null;

export const getServiceOAuthClaims = async ({
  client,
  user,
  scopes,
  grantType,
}: OAuthClaimExtensionInput) => {
  const binding = await readServiceOAuthClient(client.clientId);
  if (!binding) {
    return Result.ok({});
  }
  if (
    binding.type !== SERVICE_CLIENT_TYPE ||
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
      new APIError("FORBIDDEN", {
        error: "unauthorized_client",
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

type ServiceResolveAudit = {
  principal: ServiceOAuthPrincipal;
  route: "law" | "case";
  country: string;
  outcome:
    | LegalResolveResponse["status"]
    | "rate_limited"
    | "missing_scope"
    | "not_entitled"
    | "invalid_request"
    | "error";
};

/** Only identifiers and the typed response outcome enter the audit trail. */
export const recordServiceResolveAudit = async ({
  principal,
  route,
  country,
  outcome,
}: ServiceResolveAudit): Promise<void> => {
  await withAggregateTransaction(rootDb, async (tx) => {
    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId:
        parseAuthProviderId<"organization">(principal.organizationId) ??
        panic("Invalid service organization identity"),
      workspaceId: null,
      userId: TENANT_SYSTEM_ACTOR.serviceClient,
      execution: {
        performer: { type: "service", id: principal.clientId, name: null },
        trigger: { type: "system", source: "legal-resolve" },
      },
    });
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.ACCESS,
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_RESOLVE,
      resourceId: principal.clientId,
      metadata: { clientId: principal.clientId, route, country, outcome },
    });
  });
};

type ServiceClientOperatorAudit = {
  tx: Transaction;
  organizationId: string;
  clientId: string;
  operation: "create" | "rotate" | "disable";
  operatorUid: number;
};

export const recordServiceClientOperatorAuditEvent = async ({
  tx,
  organizationId,
  clientId,
  operation,
  operatorUid,
}: ServiceClientOperatorAudit): Promise<void> => {
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId:
      parseAuthProviderId<"organization">(organizationId) ??
      panic("Invalid service organization identity"),
    workspaceId: null,
    userId: TENANT_SYSTEM_ACTOR.serviceClientOperator,
    execution: {
      performer: {
        type: "service",
        id: TENANT_SYSTEM_ACTOR.serviceClientOperator,
        name: null,
      },
      trigger: { type: "system", source: "service-client-operator" },
    },
  });
  await recordAuditEvent(tx, {
    action: operation === "create" ? AUDIT_ACTION.CREATE : AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.SERVICE_OAUTH_CLIENT,
    resourceId: clientId,
    metadata: { operation, operatorUid },
  });
};
