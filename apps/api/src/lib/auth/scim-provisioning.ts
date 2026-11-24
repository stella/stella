import { createAuthMiddleware } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import type {
  SCIMIdentityResolution,
  SCIMIdentityResolutionContext,
  SCIMIdentityResolutionInput,
  SCIMIdentityState,
  SCIMProjectedUserState,
  SCIMScope,
  SCIMTransactionContext,
} from "@better-auth/scim";
import { scim } from "@better-auth/scim";
import { panic } from "better-result";

import { isEnterpriseSsoDeployed } from "@/api/lib/db/sso-access";
import { normalizeEmail } from "@/api/lib/email/normalized-email";

const SCIM_ENDPOINT_PREFIX = "/scim/v2/";

export const SCIM_ALL_SCOPES: readonly SCIMScope[] = [
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
];

const SCIM_CREDENTIAL_HASH_SCOPE = "stella:scim-credential-hash:v1";

/**
 * Derives an independent HMAC secret for `@better-auth/scim` managed
 * credentials from the deployment auth secret.
 */
export const deriveScimCredentialHashSecret = (secret: string): string =>
  new Bun.CryptoHasher("sha256", secret)
    .update(SCIM_CREDENTIAL_HASH_SCOPE)
    .digest("hex");

type ExistingUserRecord = {
  id: string;
  emailVerified?: boolean;
};

type ExistingMemberRecord = {
  id: string;
  role?: string;
};

export type CreateScimProvisioningPluginOptions = {
  secret: string;
  readOrganizationSeatLimit: (
    provisioningDomainId: string,
  ) => Promise<number | null>;
};

const scimDeploymentGate = createAuthMiddleware(async () => {
  if (!isEnterpriseSsoDeployed()) {
    throw new APIError("NOT_FOUND", {
      message: "SCIM directory provisioning is not enabled.",
    });
  }
});

/**
 * Inbound SCIM 2.0 service provider backed by `@better-auth/scim`.
 * Mounted always and gated behind `FEATURE_ENTERPRISE_SSO`.
 */
export const createScimProvisioningPlugin = ({
  secret,
  readOrganizationSeatLimit,
}: CreateScimProvisioningPluginOptions) => {
  const resolveUser = async (
    input: SCIMIdentityResolutionInput,
    context: SCIMIdentityResolutionContext,
  ): Promise<SCIMIdentityResolution> => {
    const email = normalizeEmail(input.resource.primaryEmail);
    const existingUser = await context.database.findOne<ExistingUserRecord>({
      model: "user",
      where: [{ field: "email", value: email }],
    });
    if (!existingUser || existingUser.emailVerified !== true) {
      return { action: "create" };
    }
    // Only link an existing user when they are already a verified member of
    // this organization; never link across organizations on email alone.
    const existingMember = await context.database.findOne<ExistingMemberRecord>(
      {
        model: "member",
        where: [
          { field: "organizationId", value: input.provisioningDomainId },
          { field: "userId", value: existingUser.id },
        ],
      },
    );
    if (!existingMember) {
      return { action: "create" };
    }
    return {
      action: "link",
      userId: existingUser.id,
      profile: "preserve",
    };
  };

  const reconcileIdentityUser = async (
    input: SCIMIdentityState,
    context: SCIMTransactionContext,
  ): Promise<void> => {
    if (!input.active) {
      await context.database.deleteMany({
        model: "session",
        where: [{ field: "userId", value: input.userId }],
      });
    }
  };

  const reconcileProjectedUser = async (
    input: SCIMProjectedUserState,
    context: SCIMTransactionContext,
  ): Promise<void> => {
    const organizationId = input.provisioningDomainId;
    const existingMember = await context.database.findOne<ExistingMemberRecord>(
      {
        model: "member",
        where: [
          { field: "organizationId", value: organizationId },
          { field: "userId", value: input.userId },
        ],
      },
    );

    if (input.active) {
      if (existingMember) {
        return;
      }
      const seatLimit = await readOrganizationSeatLimit(organizationId);
      if (seatLimit !== null) {
        const activeCount = await context.database.count({
          model: "member",
          where: [{ field: "organizationId", value: organizationId }],
        });
        if (activeCount >= seatLimit) {
          throw new APIError("FORBIDDEN", {
            message: "Organization seat limit reached.",
          });
        }
      }
      await context.database.create({
        model: "member",
        data: {
          organizationId,
          userId: input.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      return;
    }

    if (existingMember && existingMember.role !== "owner") {
      await context.database.delete({
        model: "member",
        where: [{ field: "id", value: existingMember.id }],
      });
      await context.database.deleteMany({
        model: "session",
        where: [
          { field: "userId", value: input.userId },
          { field: "activeOrganizationId", value: organizationId },
        ],
      });
    }
  };

  const plugin = scim({
    connections: [],
    managedConnections: {
      credentialHashSecret: deriveScimCredentialHashSecret(secret),
      maxActiveCredentials: 5,
      lastUsedWriteIntervalSeconds: 300,
    },
    compatibility: {
      microsoftEntra: {
        acceptLegacyGroupSchema: true,
      },
    },
    identity: {
      resolveUser,
      reconcileUser: reconcileIdentityUser,
    },
    projection: {
      reconcileUser: reconcileProjectedUser,
    },
  });

  plugin.hooks.before.unshift({
    matcher: (ctx) => ctx.path?.startsWith(SCIM_ENDPOINT_PREFIX) ?? false,
    handler: scimDeploymentGate,
  });
  const {
    scimManagedConnection,
    scimManagedCredential,
    scimManagedConnectionEvent,
    ...baseSchema
  } = plugin.schema;
  if (
    !scimManagedConnection ||
    !scimManagedCredential ||
    !scimManagedConnectionEvent
  ) {
    return panic(
      "Managed SCIM schema missing when managedConnections is configured",
    );
  }
  return {
    ...plugin,
    schema: {
      ...baseSchema,
      scimManagedConnection,
      scimManagedCredential,
      scimManagedConnectionEvent,
    },
  };
};
