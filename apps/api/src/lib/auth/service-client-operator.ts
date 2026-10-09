import { TaggedError } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { sha256Base64Url } from "@stll/sha256/bun";

import {
  oauthClient,
  oauthClientResource,
  organization,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { serviceOAuthClients } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { getMcpResourceUrl } from "@/api/mcp/constants";

import { recordServiceClientOperatorAuditEvent } from "./service-client";
import {
  SERVICE_CLIENT_SCOPES,
  SERVICE_CLIENT_TYPE,
} from "./service-client-policy";

export class ServiceClientOperatorError extends TaggedError(
  "ServiceClientOperatorError",
)<{ message: string }> {}

type CreateServiceOAuthClientOptions = {
  organizationId: string;
  name: string;
  requestsPerMinute: number;
  dailyBudget: number;
  operatorUid: number;
};

/** No service clients are seeded; only an explicit operator invocation mints one. */
export const createServiceOAuthClient = async ({
  organizationId,
  name,
  requestsPerMinute,
  dailyBudget,
  operatorUid,
}: CreateServiceOAuthClientOptions) => {
  const clientId = Bun.randomUUIDv7().replaceAll("-", "");
  const clientSecret = randomBytes(32).toString("base64url");
  await withAggregateTransaction(rootDb, async (tx) => {
    const org = (
      await tx
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, organizationId))
        .limit(1)
    ).at(0);
    if (!org) {
      return abortTransaction(
        new ServiceClientOperatorError({
          message: "Organization not found",
        }),
      );
    }
    await tx.insert(oauthClient).values({
      id: createSafeId<"mcpOAuthClient">(),
      clientId,
      registrationOrigin: "managed",
      type: SERVICE_CLIENT_TYPE,
      name,
      clientSecret: sha256Base64Url(clientSecret),
      public: false,
      requirePKCE: false,
      skipConsent: false,
      tokenEndpointAuthMethod: "client_secret_post",
      grantTypes: ["client_credentials"],
      responseTypes: [],
      redirectUris: [],
      scopes: [...SERVICE_CLIENT_SCOPES],
      clientCredentialsScopes: [...SERVICE_CLIENT_SCOPES],
    });
    await tx
      .insert(serviceOAuthClients)
      .values({ clientId, organizationId, requestsPerMinute, dailyBudget });
    await tx.insert(oauthClientResource).values({
      id: Bun.randomUUIDv7(),
      clientId,
      resourceId: getMcpResourceUrl("law"),
    });
    await recordServiceClientOperatorAuditEvent({
      tx,
      organizationId,
      clientId,
      operation: "create",
      operatorUid,
    });
  });
  return { clientId, clientSecret };
};

type ChangeServiceOAuthClientOptions = {
  clientId: string;
  operation: "rotate" | "disable";
  operatorUid: number;
};

export const changeServiceOAuthClient = async ({
  clientId,
  operation,
  operatorUid,
}: ChangeServiceOAuthClientOptions) => {
  const clientSecret =
    operation === "rotate" ? randomBytes(32).toString("base64url") : null;
  await withAggregateTransaction(rootDb, async (tx) => {
    const binding = (
      await tx
        .select({
          organizationId: serviceOAuthClients.organizationId,
          disabled: oauthClient.disabled,
          clientSecret: oauthClient.clientSecret,
        })
        .from(serviceOAuthClients)
        .innerJoin(
          oauthClient,
          eq(serviceOAuthClients.clientId, oauthClient.clientId),
        )
        .where(eq(serviceOAuthClients.clientId, clientId))
        .limit(1)
    ).at(0);
    if (!binding || (operation === "rotate" && binding.disabled)) {
      return abortTransaction(
        new ServiceClientOperatorError({
          message: "Active service client not found",
        }),
      );
    }
    const changed = await tx
      .update(oauthClient)
      .set(
        clientSecret === null
          ? { disabled: true }
          : { clientSecret: sha256Base64Url(clientSecret) },
      )
      .where(
        and(
          eq(oauthClient.clientId, clientId),
          eq(oauthClient.disabled, binding.disabled),
          binding.clientSecret === null
            ? isNull(oauthClient.clientSecret)
            : eq(oauthClient.clientSecret, binding.clientSecret),
        ),
      )
      .returning({ clientId: oauthClient.clientId });
    if (changed.length !== 1) {
      return abortTransaction(
        new ServiceClientOperatorError({
          message: "Service client changed; run the operation again",
        }),
      );
    }
    if (operation === "rotate") {
      await tx
        .update(serviceOAuthClients)
        .set({
          credentialVersion: sql`${serviceOAuthClients.credentialVersion} + 1`,
        })
        .where(eq(serviceOAuthClients.clientId, clientId));
    }
    await recordServiceClientOperatorAuditEvent({
      tx,
      organizationId: binding.organizationId,
      clientId,
      operation,
      operatorUid,
    });
  });
  return { clientId, clientSecret };
};
