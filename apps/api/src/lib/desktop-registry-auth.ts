import { Result } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { rlsDb } from "@/api/db/root";
import { createMembershipScopedDb } from "@/api/db/scoped";
import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_PERMISSION,
  desktopRegistryMetadata,
} from "@/api/handlers/desktop-registry/config";
import { getAuth, resolveMemberAuthorization } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";

const rejected = () =>
  new HandlerError({
    status: 401,
    message: "Reconnect the desktop registry search to your account",
  });

// Authentication owns the RLS bootstrap; registry handlers receive only the
// resulting scoped database. This never creates a browser or MCP session.
export const authorizeDesktopRegistry = async (request: Request) => {
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
  if (
    !valid ||
    !key?.enabled ||
    !key.expiresAt ||
    key.expiresAt.getTime() <= Temporal.Now.instant().epochMilliseconds
  ) {
    return Result.err(rejected());
  }
  const metadata = v.safeParse(desktopRegistryMetadata, key.metadata);
  if (!metadata.success) {
    return Result.err(rejected());
  }
  const identity = brandActorSessionIdentity({
    organizationId: metadata.output.organizationId,
    userId: key.referenceId,
  });
  const member = await Result.tryPromise({
    try: async () => await resolveMemberAuthorization(identity),
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
    !hasMemberPermission(
      { role: member.value.role },
      DESKTOP_REGISTRY_PERMISSION,
    )
  ) {
    return Result.err(rejected());
  }
  return Result.ok({
    ...identity,
    keyId: key.id,
    scopedDb: createMembershipScopedDb(rlsDb, {
      ...identity,
      serverValidatedWorkspaceIds: [],
    }),
  });
};
