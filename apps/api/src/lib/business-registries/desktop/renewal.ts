import { defaultKeyHasher } from "@better-auth/api-key";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { apikey, member } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DESKTOP_ACCOUNT_PERMISSION,
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_KEY_SECONDS,
} from "@/api/lib/business-registries/desktop/config";
import { desktopRegistryKeyOrganizationScope } from "@/api/lib/business-registries/desktop/scope";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasCurrentMemberPermission } from "@/api/lib/permission-authorization";

const isDesktopSuccessorKey = (key: string) =>
  key.startsWith(DESKTOP_REGISTRY_KEY_PREFIX) &&
  /^[a-f0-9]{128}$/u.test(key.slice(DESKTOP_REGISTRY_KEY_PREFIX.length));

const rejected = () =>
  new HandlerError({
    status: 401,
    message: "Reconnect desktop to your account",
  });

type RenewDesktopCredentialOptions = {
  keyId: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  currentKey: string;
  successorKey: string;
  recordAuditEvent: AuditRecorder;
  db?: Pick<typeof rootDb, "transaction">;
  now?: Date;
};

// Membership lifecycle locks the member before credentials. Revocation takes
// this same credential row lock, so no rotation can restore a disabled key.
export const renewDesktopCredential = async ({
  keyId,
  userId,
  organizationId,
  currentKey,
  successorKey,
  recordAuditEvent,
  db = rootDb,
  now,
}: RenewDesktopCredentialOptions) => {
  if (!isDesktopSuccessorKey(successorKey) || successorKey === currentKey) {
    return Result.err(rejected());
  }
  const currentHash = await defaultKeyHasher(currentKey);
  const successorHash = await defaultKeyHasher(successorKey);
  const outcome = await Result.tryPromise({
    try: async () =>
      await db.transaction(async (tx) => {
        const [membership] = await tx
          .select({ role: member.role })
          .from(member)
          .where(
            and(
              eq(member.userId, userId),
              eq(member.organizationId, organizationId),
            ),
          )
          .for("update");
        if (
          !membership ||
          !isMemberRole(membership.role) ||
          !hasCurrentMemberPermission(
            membership.role,
            DESKTOP_ACCOUNT_PERMISSION,
          )
        ) {
          return Result.err(rejected());
        }
        const [key] = await tx
          .select({
            hash: apikey.key,
            enabled: apikey.enabled,
            expiresAt: apikey.expiresAt,
          })
          .from(apikey)
          .where(
            and(
              eq(apikey.id, keyId),
              eq(apikey.referenceId, userId),
              desktopRegistryKeyOrganizationScope(organizationId),
            ),
          )
          .for("update");
        const usedAt =
          now ?? new Date(Temporal.Now.instant().epochMilliseconds);
        if (
          !key ||
          key.hash !== currentHash ||
          !key.enabled ||
          !key.expiresAt ||
          key.expiresAt.getTime() <= usedAt.getTime()
        ) {
          return Result.err(rejected());
        }
        const expiresAt = new Date(
          usedAt.getTime() + DESKTOP_REGISTRY_KEY_SECONDS * 1000,
        );
        const rotated = await tx
          .update(apikey)
          .set({
            key: successorHash,
            start: successorKey.slice(
              0,
              DESKTOP_REGISTRY_KEY_PREFIX.length + 6,
            ),
            expiresAt,
            updatedAt: usedAt,
          })
          .where(
            and(
              eq(apikey.id, keyId),
              eq(apikey.key, currentHash),
              eq(apikey.enabled, true),
              eq(apikey.referenceId, userId),
              desktopRegistryKeyOrganizationScope(organizationId),
            ),
          )
          .returning({ id: apikey.id });
        if (rotated.length !== 1) {
          panic("A locked desktop credential must rotate exactly once");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
          resourceId: keyId,
          metadata: {
            purpose: DESKTOP_REGISTRY_KEY_CONFIG,
            operation: "rotate",
            expiresAt: expiresAt.toISOString(),
          },
        });
        return Result.ok({ expiresAt: expiresAt.toISOString() });
      }),
    catch: (cause) =>
      HandlerError.is(cause)
        ? cause
        : new HandlerError({
            status: 503,
            message: "Desktop account renewal is unavailable",
            cause,
          }),
  });
  return outcome.andThen((result) => result);
};

type ProbeDesktopCredentialOptions = Omit<
  RenewDesktopCredentialOptions,
  "successorKey" | "recordAuditEvent"
>;

// Recovery only observes the current generation; polling must never renew it.
export const probeDesktopCredential = async ({
  keyId,
  userId,
  organizationId,
  currentKey,
  db = rootDb,
  now = new Date(Temporal.Now.instant().epochMilliseconds),
}: ProbeDesktopCredentialOptions) => {
  const hash = await defaultKeyHasher(currentKey);
  const queried = await Result.tryPromise({
    try: async () =>
      await db.transaction(
        async (tx) =>
          await tx
            .select({ expiresAt: apikey.expiresAt })
            .from(apikey)
            .where(
              and(
                eq(apikey.id, keyId),
                eq(apikey.referenceId, userId),
                eq(apikey.key, hash),
                eq(apikey.enabled, true),
                desktopRegistryKeyOrganizationScope(organizationId),
              ),
            )
            .limit(1),
      ),
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Desktop account recovery is unavailable",
        cause,
      }),
  });
  if (queried.isErr()) {
    return queried;
  }
  const key = queried.value.at(0);
  if (!key?.expiresAt || key.expiresAt.getTime() <= now.getTime()) {
    return Result.err(rejected());
  }
  return Result.ok({ expiresAt: key.expiresAt.toISOString() });
};
