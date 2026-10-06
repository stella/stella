import { defaultKeyHasher } from "@better-auth/api-key";
import { Result } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import { rlsDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { getAuth, resolveCredentialMemberAuthorization } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DESKTOP_ACCOUNT_PERMISSION,
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_PERMISSION,
  parseDesktopRegistryMetadata,
} from "@/api/lib/business-registries/desktop/config";
import {
  VerifiedDesktopDeviceProof,
  desktopProofRequestUrl,
} from "@/api/lib/business-registries/desktop/proof";
import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";
import { probeDesktopCredential } from "@/api/lib/business-registries/desktop/renewal";
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
    status: 401,
    message: "Reconnect desktop to your account",
  });

// Authentication owns the RLS bootstrap; registry handlers receive only the
// resulting scoped database. This never creates a browser or MCP session.
type DesktopRegistryAuthorization = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  keyId: string;
  consumedProof: ConsumedDesktopDeviceProof;
  scopedDb: ScopedDb;
};

const authorizeDesktopCredential = async (
  request: Request,
  permission: PermissionInput,
): Promise<Result<DesktopRegistryAuthorization, HandlerError<401 | 503>>> => {
  const authorization = request.headers.get("authorization");
  if (
    !authorization?.startsWith(`Bearer ${DESKTOP_REGISTRY_KEY_PREFIX}`) ||
    authorization.length > 256
  ) {
    return Result.err(rejected());
  }
  const verified = await Result.tryPromise({
    try: async () =>
      await getAuth().api.verifyApiKey({
        body: {
          configId: DESKTOP_REGISTRY_KEY_CONFIG,
          key: authorization.slice(7),
        },
      }),
    catch: () =>
      new HandlerError({
        status: 503,
        message: "Registry authorization is unavailable",
      }),
  });
  if (verified.isErr()) {
    return Result.err(verified.error);
  }
  const { key, valid } = verified.value;
  if (!valid || !key?.enabled || key.expiresAt !== null) {
    return Result.err(rejected());
  }
  const metadata = parseDesktopRegistryMetadata(key.metadata);
  if (!metadata.success) {
    return Result.err(rejected());
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
          message: "Desktop connection cleanup failed",
        }),
    });
    if (revoked.isErr()) {
      return Result.err(revoked.error);
    }
    return Result.err(rejected());
  }
  const member = await Result.tryPromise({
    try: async () => await resolveCredentialMemberAuthorization(identity),
    catch: () =>
      new HandlerError({
        status: 503,
        message: "Registry authorization is unavailable",
      }),
  });
  if (member.isErr()) {
    return Result.err(member.error);
  }
  if (
    !member.value ||
    !isMemberRole(member.value.role) ||
    // The desktop account acts with the person's own live role.
    !hasMemberPermission(sessionMemberRole(member.value.role), permission)
  ) {
    return Result.err(rejected());
  }
  return Result.ok({
    ...identity,
    keyId: key.id,
    consumedProof: consumed.value,
    scopedDb: createMembershipScopedDb(rlsDb, {
      ...identity,
      serverValidatedWorkspaceIds: [],
    }),
  });
};

export const authorizeDesktopAccount = async (request: Request) =>
  await authorizeDesktopCredential(request, DESKTOP_ACCOUNT_PERMISSION);

export const authorizeDesktopRegistry = async (request: Request) =>
  await authorizeDesktopCredential(request, DESKTOP_REGISTRY_PERMISSION);
