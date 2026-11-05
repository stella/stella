import { defaultKeyHasher } from "@better-auth/api-key";
import { Result } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import { rlsDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createAuditRecorder } from "@/api/lib/audit-log";
import {
  featureAccessSnapshotFromAuthorization,
  getAuth,
  resolveCredentialMemberAuthorization,
} from "@/api/lib/auth";
import type { VerifyApiKey } from "@/api/lib/auth/api-key-endpoints";
import {
  API_KEY_REFUSAL_REASON,
  type ApiKeyRefusalReason,
  apiKeyVerificationRefusalReason,
  logApiKeyRefusal,
} from "@/api/lib/auth/api-key-refusal-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DESKTOP_ACCOUNT_PERMISSION,
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_PERMISSION,
  parseDesktopRegistryMetadata,
} from "@/api/lib/business-registries/desktop/config";
import {
  desktopProofRequestUrl,
  VerifiedDesktopDeviceProof,
} from "@/api/lib/business-registries/desktop/proof";
import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";
import { probeDesktopCredential } from "@/api/lib/business-registries/desktop/renewal";
import {
  DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_MAX_LENGTH,
  DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX,
  DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE,
} from "@/api/lib/business-registries/desktop/request-contract";
import { revokeDesktopRegistryCredential } from "@/api/lib/business-registries/desktop/revocation";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";

const rejected = () =>
  new HandlerError({
    status: DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.status,
    message: DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE.body.message,
  });

const forbidden = () =>
  new HandlerError({
    status: 403,
    message: "Your role does not allow this desktop operation",
  });

/**
 * A missing membership ends the account link (401); a live member whose role
 * lacks the operation's permission keeps it (403). The desktop account acts
 * with the person's own live role.
 */
export const authorizeDesktopMember = (
  member: { role: string } | null,
  permission: PermissionInput,
): Result<ReturnType<typeof sessionMemberRole>, HandlerError<401 | 403>> => {
  if (!member || !isMemberRole(member.role)) {
    return Result.err(rejected());
  }
  const memberRole = sessionMemberRole(member.role);
  if (!hasMemberPermission(memberRole, permission)) {
    return Result.err(forbidden());
  }
  return Result.ok(memberRole);
};

// Authentication owns the RLS bootstrap; registry handlers receive only the
// resulting scoped database. This never creates a browser or MCP session.
type DesktopRegistryAuthorization = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  keyId: string;
  consumedProof: ConsumedDesktopDeviceProof;
  scopedDb: ScopedDb;
  memberRole: ReturnType<typeof sessionMemberRole>;
  featureAccessSnapshot: ReturnType<
    typeof featureAccessSnapshotFromAuthorization
  >;
};

// The credential stores take the owner connection as an optional `db` and
// default to it, so production passes none and only the matrix substitutes.
type DesktopCredentialOwnerDb = NonNullable<
  Parameters<typeof probeDesktopCredential>[0]["db"]
>;

type DesktopCredentialInfrastructure = {
  ownerDb?: DesktopCredentialOwnerDb;
  membershipDb: typeof rlsDb;
  // A getter, so authentication starts only for a request that carries a
  // desktop credential, inside the step that maps its failure to 503.
  verifyApiKey: () => VerifyApiKey;
  resolveMember: typeof resolveCredentialMemberAuthorization;
};

/**
 * Builds the desktop credential authorizers over explicit infrastructure so
 * the cross-tenant matrix can drive the real authorization path against its
 * own databases. Production uses `authorizeDesktopAccount` and
 * `authorizeDesktopRegistry` below.
 */
export const createDesktopCredentialAuthorizers = ({
  ownerDb,
  membershipDb,
  verifyApiKey,
  resolveMember,
}: DesktopCredentialInfrastructure) => {
  // Omitted for production, so each store keeps its own owner default.
  const ownerDbOption = ownerDb === undefined ? {} : { db: ownerDb };

  const authorizeDesktopCredential = async (
    request: Request,
    permission: PermissionInput,
  ): Promise<
    Result<DesktopRegistryAuthorization, HandlerError<401 | 403 | 503>>
  > => {
    const authorization = request.headers.get("authorization");
    if (
      !authorization?.startsWith(
        DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX,
      ) ||
      authorization.length > DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_MAX_LENGTH
    ) {
      return Result.err(rejected());
    }
    const verified = await Result.tryPromise({
      try: async () =>
        await verifyApiKey()({
          body: {
            configId: DESKTOP_REGISTRY_KEY_CONFIG,
            key: authorization.slice(7),
          },
        }),
      catch: () =>
        new HandlerError({
          status: 503,
          code: "internal_error",
          message: "Registry authorization is unavailable",
        }),
    });
    if (verified.isErr()) {
      return Result.err(verified.error);
    }
    const { key, valid } = verified.value;
    const rejectKey = (
      reason: ApiKeyRefusalReason,
      error: HandlerError<401 | 403> = rejected(),
    ) => {
      logApiKeyRefusal({
        reason,
        mode: "desktop",
        ...(key ? { key: { start: key.start } } : {}),
      });
      return error;
    };
    if (!valid || !key) {
      return Result.err(
        rejectKey(apiKeyVerificationRefusalReason(verified.value.error?.code)),
      );
    }
    if (!key.enabled) {
      return Result.err(rejectKey(API_KEY_REFUSAL_REASON.disabled));
    }
    if (key.expiresAt !== null) {
      return Result.err(rejectKey(API_KEY_REFUSAL_REASON.invalidMetadata));
    }
    const metadata = parseDesktopRegistryMetadata(key.metadata);
    if (!metadata.success) {
      return Result.err(rejectKey(API_KEY_REFUSAL_REASON.invalidMetadata));
    }
    const proof = await VerifiedDesktopDeviceProof.verify({
      request,
      expectedUrl: desktopProofRequestUrl(
        request,
        env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
      ),
      expectedThumbprint: metadata.output.deviceJkt,
      binding: {
        type: "account",
        keyId: key.id,
        credential: authorization.slice(7),
      },
    });
    if (proof.isErr()) {
      return Result.err(proof.error);
    }
    const consumed = await ConsumedDesktopDeviceProof.claim({
      proof: proof.value,
      ...ownerDbOption,
    });
    if (consumed.isErr()) {
      return Result.err(consumed.error);
    }
    const identity = brandActorSessionIdentity({
      organizationId: metadata.output.organizationId,
      userId: key.referenceId,
    });
    const currentKey = authorization.slice(7);
    const deadline = await probeDesktopCredential({
      keyId: key.id,
      ...ownerDbOption,
      ...identity,
      currentKey,
    });
    if (deadline.isErr()) {
      if (deadline.error.status !== 401) {
        return Result.err(deadline.error);
      }
      const revoked = await Result.tryPromise({
        try: async () =>
          await revokeDesktopRegistryCredential({
            keyId: key.id,
            ...ownerDbOption,
            ...identity,
            expectedKeyHash: await defaultKeyHasher(currentKey),
            recordAuditEvent: createAuditRecorder({
              ...identity,
              workspaceId: null,
              request,
              server: null,
            }),
          }),
        catch: () =>
          new HandlerError({
            status: 503,
            code: "internal_error",
            message: "Desktop connection cleanup failed",
          }),
      });
      if (revoked.isErr()) {
        return Result.err(revoked.error);
      }
      return Result.err(rejectKey(API_KEY_REFUSAL_REASON.expired));
    }
    const member = await Result.tryPromise({
      try: async () => await resolveMember(identity),
      catch: () =>
        new HandlerError({
          status: 503,
          code: "internal_error",
          message: "Registry authorization is unavailable",
        }),
    });
    if (member.isErr()) {
      return Result.err(member.error);
    }
    if (member.value === null) {
      return Result.err(rejectKey(API_KEY_REFUSAL_REASON.inactiveMember));
    }
    const memberRole = authorizeDesktopMember(member.value, permission);
    if (memberRole.isErr()) {
      return Result.err(
        rejectKey(
          memberRole.error.status === 401
            ? API_KEY_REFUSAL_REASON.inactiveMember
            : API_KEY_REFUSAL_REASON.rolePermissions,
          memberRole.error,
        ),
      );
    }
    return Result.ok({
      ...identity,
      keyId: key.id,
      memberRole: memberRole.value,
      featureAccessSnapshot: featureAccessSnapshotFromAuthorization({
        ...identity,
        authorization: member.value,
      }),
      consumedProof: consumed.value,
      scopedDb: createMembershipScopedDb(membershipDb, {
        ...identity,
        serverValidatedWorkspaceIds: [],
      }),
    });
  };

  return {
    authorizeDesktopAccount: async (request: Request) =>
      await authorizeDesktopCredential(request, DESKTOP_ACCOUNT_PERMISSION),
    authorizeDesktopRegistry: async (request: Request) =>
      await authorizeDesktopCredential(request, DESKTOP_REGISTRY_PERMISSION),
  };
};

const productionAuthorizers = () =>
  createDesktopCredentialAuthorizers({
    membershipDb: rlsDb,
    verifyApiKey: () => getAuth().api.verifyApiKey,
    resolveMember: resolveCredentialMemberAuthorization,
  });

export const authorizeDesktopAccount = async (request: Request) =>
  await productionAuthorizers().authorizeDesktopAccount(request);

export const authorizeDesktopRegistry = async (request: Request) =>
  await productionAuthorizers().authorizeDesktopRegistry(request);
