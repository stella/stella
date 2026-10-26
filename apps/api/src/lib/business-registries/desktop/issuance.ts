import { defaultKeyHasher } from "@better-auth/api-key";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { apikey, member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { CredentialIssuanceFence } from "@/api/lib/auth-artifacts";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DESKTOP_ACCOUNT_PERMISSION,
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_KEY_SECONDS,
  DESKTOP_REGISTRY_KEY_START_LENGTH,
  desktopRegistryKeyConfig,
} from "@/api/lib/business-registries/desktop/config";
import {
  withAggregateLock,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasCurrentMemberPermission } from "@/api/lib/permission-authorization";

type DesktopCredentialRequest = {
  body: {
    configId: typeof DESKTOP_REGISTRY_KEY_CONFIG;
    name: string;
    userId: SafeId<"user">;
    expiresIn: null;
    metadata: {
      purpose: typeof DESKTOP_REGISTRY_KEY_CONFIG;
      organizationId: SafeId<"organization">;
      deviceJkt: string;
      inactivityExpiresAt: string;
    };
  };
};

/**
 * Writes a desktop credential in the provider's row format inside the fenced
 * transaction, so an access reset either revokes it or finds no session to
 * issue it under. The key has the format desktop renewal rotates to.
 */
const desktopCredentialWriter = (
  fence: CredentialIssuanceFence,
  now: Date,
) => ({
  createApiKey: async ({ body }: DesktopCredentialRequest) => {
    if (body.userId !== fence.userId) {
      return panic("A desktop credential is issued only to the fenced account");
    }
    const key = `${DESKTOP_REGISTRY_KEY_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("hex")}`;
    const id = Bun.randomUUIDv7();
    // audit: skip - the issuer records the credential's receipt in this fenced transaction
    await fence.tx.insert(apikey).values({
      id,
      configId: body.configId,
      referenceId: body.userId,
      name: body.name,
      prefix: DESKTOP_REGISTRY_KEY_PREFIX,
      start: key.slice(0, DESKTOP_REGISTRY_KEY_START_LENGTH),
      key: await defaultKeyHasher(key),
      metadata: JSON.stringify(body.metadata),
      expiresAt: body.expiresIn,
      createdAt: now,
      updatedAt: now,
      enabled: true,
      rateLimitEnabled: desktopRegistryKeyConfig.rateLimit.enabled,
      rateLimitMax: desktopRegistryKeyConfig.rateLimit.maxRequests,
      rateLimitTimeWindow: desktopRegistryKeyConfig.rateLimit.timeWindow,
    });
    return { id, key };
  },
});

const unavailable = () =>
  new HandlerError({ status: 401, message: "Desktop account is unavailable" });

export type DesktopCredentialIdentity = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  deviceJkt: string;
  /** The browser session that issued the connection request. */
  sessionId: string;
};

type IssueDesktopAccountCredentialOptions = {
  identity: DesktopCredentialIdentity;
  recordAuditEvent: AuditRecorder;
  database?: Pick<typeof rootDb, "transaction">;
};

/**
 * Mints the desktop account credential a connection request authorizes. The
 * issuing session must still be live under the account's credential fence and
 * the person must still hold the desktop permission under the membership lock;
 * the key and its audit receipt commit together.
 */
export const issueDesktopAccountCredential = async ({
  identity,
  recordAuditEvent,
  database = rootDb,
}: IssueDesktopAccountCredentialOptions) =>
  await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(database, async (tx) => {
        const fence = await CredentialIssuanceFence.hold(tx, {
          userId: identity.userId,
          sessionId: identity.sessionId,
        });
        if (fence === null) {
          return abortTransaction(
            new HandlerError({
              status: 401,
              message: "Sign in again to connect stella desktop",
            }),
          );
        }
        const membershipLock = await withAggregateLock({
          aggregate: "desktopMembership",
          id: {
            organizationId: identity.organizationId,
            userId: identity.userId,
          },
          mode: "share",
          tx,
        });
        if (membershipLock.status === "missing") {
          return abortTransaction(unavailable());
        }
        const [membership] = await tx
          .select({ role: member.role, email: user.email, name: user.name })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(
            and(
              eq(member.userId, identity.userId),
              eq(member.organizationId, identity.organizationId),
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
          return abortTransaction(unavailable());
        }
        const [org] = await tx
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, identity.organizationId));
        if (!org) {
          return abortTransaction(unavailable());
        }
        const now = new Date(Temporal.Now.instant().epochMilliseconds);
        const expiresAt = new Date(
          now.getTime() + DESKTOP_REGISTRY_KEY_SECONDS * 1000,
        );
        const minted = await desktopCredentialWriter(fence, now).createApiKey({
          body: {
            configId: DESKTOP_REGISTRY_KEY_CONFIG,
            name: "Desktop account",
            userId: identity.userId,
            expiresIn: null,
            metadata: {
              purpose: DESKTOP_REGISTRY_KEY_CONFIG,
              organizationId: identity.organizationId,
              deviceJkt: identity.deviceJkt,
              inactivityExpiresAt: expiresAt.toISOString(),
            },
          },
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
          resourceId: minted.id,
          metadata: { purpose: DESKTOP_REGISTRY_KEY_CONFIG },
        });
        return {
          account: { email: membership.email, name: membership.name },
          organizationName: org.name,
          key: minted.key,
          expiresAt,
        };
      }),
    catch: (cause) =>
      HandlerError.is(cause)
        ? cause
        : new HandlerError({
            status: 503,
            message: "Could not connect desktop account",
            cause,
          }),
  });
