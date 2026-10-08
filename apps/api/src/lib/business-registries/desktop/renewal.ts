import { defaultKeyHasher } from "@better-auth/api-key";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { apikey, member } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DESKTOP_ACCOUNT_PERMISSION,
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_KEY_SECONDS,
  DESKTOP_REGISTRY_ROTATION_INTERVAL_SECONDS,
  parseDesktopRegistryMetadata,
} from "@/api/lib/business-registries/desktop/config";
import { desktopRegistryKeyOrganizationScope } from "@/api/lib/business-registries/desktop/scope";
import {
  withAggregateLock,
  withAggregateSavepoint,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
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

const tooSoon = () =>
  new HandlerError({
    status: 429,
    message: "Desktop credential was renewed moments ago",
  });

type RenewalDatabase =
  | Pick<typeof rootDb, "transaction">
  | Pick<Transaction, "execute" | "transaction" | "rollback">;

// Requests own a fresh transaction. An enclosing transaction (rollback
// fixtures) nests the same lock sequence in a tracked savepoint instead.
const withRenewalTransaction = async <T>(
  db: RenewalDatabase,
  run: (tx: Transaction) => Promise<T>,
) =>
  "rollback" in db
    ? await withAggregateSavepoint(db, run)
    : await withAggregateTransaction(db, run);

type RenewDesktopCredentialOptions = {
  keyId: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  currentKey: string;
  successorKey: string;
  recordAuditEvent: AuditRecorder;
  db?: RenewalDatabase;
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
      await withRenewalTransaction(db, async (tx) => {
        const membershipLock = await withAggregateLock({
          aggregate: "desktopMembership",
          id: { organizationId, userId },
          mode: "update",
          tx,
        });
        if (membershipLock.status === "missing") {
          return Result.err(rejected());
        }
        const [membership] = await tx
          .select({ role: member.role })
          .from(member)
          .where(
            and(
              eq(member.userId, userId),
              eq(member.organizationId, organizationId),
            ),
          );
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
        const keyLock = await withAggregateLock({
          aggregate: "desktopCredential",
          id: { id: keyId, userId },
          mode: "update",
          tx,
        });
        if (keyLock.status === "missing") {
          return Result.err(rejected());
        }
        const [key] = await tx
          .select({
            hash: apikey.key,
            enabled: apikey.enabled,
            expiresAt: apikey.expiresAt,
            metadata: apikey.metadata,
          })
          .from(apikey)
          .where(
            and(
              eq(apikey.id, keyId),
              eq(apikey.referenceId, userId),
              desktopRegistryKeyOrganizationScope(organizationId),
            ),
          );
        const usedAt =
          now ?? new Date(Temporal.Now.instant().epochMilliseconds);
        const metadata = parseDesktopRegistryMetadata(key?.metadata);
        if (
          !key ||
          key.hash !== currentHash ||
          !key.enabled ||
          key.expiresAt !== null ||
          !metadata.success ||
          Temporal.Instant.from(metadata.output.inactivityExpiresAt)
            .epochMilliseconds <= usedAt.getTime()
        ) {
          return Result.err(rejected());
        }
        // Linking and rotation both stamp the deadline from their own clock, so
        // it dates the current generation without trusting provider updatedAt,
        // which every authenticated request bumps.
        const issuedAt =
          Temporal.Instant.from(metadata.output.inactivityExpiresAt)
            .epochMilliseconds -
          DESKTOP_REGISTRY_KEY_SECONDS * 1000;
        if (
          usedAt.getTime() - issuedAt <
          DESKTOP_REGISTRY_ROTATION_INTERVAL_SECONDS * 1000
        ) {
          return Result.err(tooSoon());
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
            expiresAt: null,
            metadata: JSON.stringify({
              ...metadata.output,
              inactivityExpiresAt: expiresAt.toISOString(),
            }),
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
  now,
}: ProbeDesktopCredentialOptions) => {
  const hash = await defaultKeyHasher(currentKey);
  const queried = await Result.tryPromise({
    try: async () =>
      await withRenewalTransaction(db, async (tx) => {
        const keyLock = await withAggregateLock({
          aggregate: "desktopCredential",
          id: { id: keyId, userId },
          mode: "update",
          tx,
        });
        if (keyLock.status === "missing") {
          return Result.err(rejected());
        }
        const [key] = await tx
          .select({ expiresAt: apikey.expiresAt, metadata: apikey.metadata })
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
          .limit(1);
        const metadata = parseDesktopRegistryMetadata(key?.metadata);
        const checkedAt =
          now ?? new Date(Temporal.Now.instant().epochMilliseconds);
        if (
          !key ||
          key.expiresAt !== null ||
          !metadata.success ||
          Temporal.Instant.from(metadata.output.inactivityExpiresAt)
            .epochMilliseconds <= checkedAt.getTime()
        ) {
          return Result.err(rejected());
        }
        return Result.ok({ expiresAt: metadata.output.inactivityExpiresAt });
      }),
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Desktop account recovery is unavailable",
        cause,
      }),
  });
  return queried.andThen((result) => result);
};
