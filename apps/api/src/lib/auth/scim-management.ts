import { isAPIError } from "@better-auth/core/utils/is-api-error";
import type { SCIMManagedCredential } from "@better-auth/scim";
import { Result, TaggedError } from "better-result";
import { randomBytes } from "node:crypto";

import type {
  CreateOrganizationScimTokenResponse,
  OrganizationScimTokenSummary,
} from "@stll/api-contract/sso";
import { declareFingerprintFields } from "@stll/errors";
import { DAY_IN_MS, Temporal } from "@stll/time";

import { getAuth } from "@/api/lib/auth";
import { SCIM_ALL_SCOPES } from "@/api/lib/auth/scim-provisioning";
import type { SafeId } from "@/api/lib/branded-types";

const DEFAULT_TOKEN_LIFETIME_DAYS = 365;

export class ScimManagementError extends TaggedError("ScimManagementError")<{
  reason: "not_found" | "token_limit_reached" | "operation_failed";
  message: string;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const toSummary = (
  credential: SCIMManagedCredential,
): OrganizationScimTokenSummary => ({
  id: credential.credentialId,
  status: credential.status,
  expiresAt: credential.expiresAt.toISOString(),
  createdAt: credential.createdAt.toISOString(),
  lastUsedAt: credential.lastUsedAt
    ? credential.lastUsedAt.toISOString()
    : null,
  revokedAt: credential.revokedAt ? credential.revokedAt.toISOString() : null,
});

const mapPluginError = (error: unknown): ScimManagementError => {
  if (isAPIError(error)) {
    if (error.statusCode === 404) {
      return new ScimManagementError({
        reason: "not_found",
        message: "SCIM token not found.",
      });
    }
    if (error.statusCode === 409) {
      return new ScimManagementError({
        reason: "token_limit_reached",
        message:
          "Maximum number of active SCIM tokens reached. Revoke an unused token first.",
      });
    }
  }
  return new ScimManagementError({
    reason: "operation_failed",
    message: "Failed to manage SCIM credential.",
  });
};

export const listOrganizationScimTokens = async (
  organizationId: SafeId<"organization">,
): Promise<Result<OrganizationScimTokenSummary[], ScimManagementError>> =>
  await Result.tryPromise({
    try: async () => {
      const auth = getAuth();
      const { connections } = await auth.api.listSCIMManagedConnections({
        body: { provisioningDomainId: organizationId },
      });
      const activeConnection = connections.find((c) => c.status === "active");
      if (!activeConnection) {
        return [];
      }
      const { credentials } = await auth.api.getSCIMManagedConnection({
        body: {
          connectionId: activeConnection.connectionId,
          provisioningDomainId: organizationId,
        },
      });
      return credentials.map(toSummary).toSorted((a, b) => {
        if (a.createdAt < b.createdAt) {
          return 1;
        }
        if (a.createdAt > b.createdAt) {
          return -1;
        }
        return 0;
      });
    },
    catch: mapPluginError,
  });

export type CreateOrganizationScimTokenArgs = {
  organizationId: SafeId<"organization">;
  actorId: SafeId<"user">;
  expiresInDays?: number | undefined;
};

export const createOrganizationScimToken = async ({
  organizationId,
  actorId,
  expiresInDays,
}: CreateOrganizationScimTokenArgs): Promise<
  Result<CreateOrganizationScimTokenResponse, ScimManagementError>
> =>
  await Result.tryPromise({
    try: async () => {
      const auth = getAuth();
      const lifetimeDays = expiresInDays ?? DEFAULT_TOKEN_LIFETIME_DAYS;
      const expiresAt = new Date(
        Temporal.Now.instant().epochMilliseconds + lifetimeDays * DAY_IN_MS,
      );

      const { connections } = await auth.api.listSCIMManagedConnections({
        body: { provisioningDomainId: organizationId },
      });
      const activeConnection = connections.find((c) => c.status === "active");

      if (!activeConnection) {
        const created = await auth.api.createSCIMManagedConnection({
          body: {
            provisioningDomainId: organizationId,
            actorId,
            creationRequestId: `scim_req_${randomBytes(16).toString("hex")}`,
            scopes: [...SCIM_ALL_SCOPES],
            expiresAt,
          },
        });
        return {
          token: toSummary(created.credential),
          bearerToken: created.token,
        };
      }

      const rotated = await auth.api.rotateSCIMManagedCredential({
        body: {
          connectionId: activeConnection.connectionId,
          provisioningDomainId: organizationId,
          actorId,
          scopes: [...SCIM_ALL_SCOPES],
          expiresAt,
        },
      });
      return {
        token: toSummary(rotated.credential),
        bearerToken: rotated.token,
      };
    },
    catch: mapPluginError,
  });

export type RevokeOrganizationScimTokenArgs = {
  organizationId: SafeId<"organization">;
  credentialId: string;
  actorId: SafeId<"user">;
};

export const revokeOrganizationScimToken = async ({
  organizationId,
  credentialId,
  actorId,
}: RevokeOrganizationScimTokenArgs): Promise<
  Result<{ revoked: true }, ScimManagementError>
> => {
  const listed = await Result.tryPromise({
    try: async () => {
      const auth = getAuth();
      const { connections } = await auth.api.listSCIMManagedConnections({
        body: { provisioningDomainId: organizationId },
      });
      return connections.find((c) => c.status === "active") ?? null;
    },
    catch: mapPluginError,
  });
  if (listed.isErr()) {
    return Result.err(listed.error);
  }
  if (!listed.value) {
    return Result.err(
      new ScimManagementError({
        reason: "not_found",
        message: "SCIM token not found.",
      }),
    );
  }
  const activeConnection = listed.value;
  return await Result.tryPromise({
    try: async () => {
      const auth = getAuth();
      await auth.api.revokeSCIMManagedCredential({
        body: {
          connectionId: activeConnection.connectionId,
          provisioningDomainId: organizationId,
          credentialId,
          actorId,
        },
      });
      return { revoked: true as const };
    },
    catch: mapPluginError,
  });
};
