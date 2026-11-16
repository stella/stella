import {
  and,
  desc,
  eq,
  gt,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  PUSH_DEVICES_PER_USER_MAX,
  type PushDeviceRegistration,
} from "@stll/api-contract/mobile-push";

import type { Transaction } from "@/api/db/root";
import { pushDevices } from "@/api/db/schema";
import type { PushDeviceRow } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { BoundedReadResult } from "@/api/lib/db/read-bounded";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";

type DeviceWriteTx = Pick<Transaction, "insert" | "select" | "delete">;

/**
 * Register the device a person's app runs on, or refresh it: the same token
 * again moves the row to the organization the app is now signed in to and
 * bumps `lastSeenAt`. Past {@link PUSH_DEVICES_PER_USER_MAX} the devices seen
 * longest ago are dropped, so phones that were wiped without signing out do
 * not accumulate.
 */
export const registerPushDevice = async (
  tx: DeviceWriteTx,
  {
    organizationId,
    registration,
    userId,
  }: {
    organizationId: SafeId<"organization">;
    registration: PushDeviceRegistration;
    userId: SafeId<"user">;
  },
): Promise<PushDeviceRow | undefined> => {
  const device = {
    organizationId,
    platform: registration.platform,
    environment: registration.environment,
    bundleId: registration.bundleId,
    appVersion: registration.appVersion,
    locale: registration.locale,
  };
  // audit: skip - the person's own alert delivery address, holding no content
  const [row] = await tx
    .insert(pushDevices)
    .values({ ...device, userId, token: registration.token })
    .onConflictDoUpdate({
      target: [pushDevices.userId, pushDevices.token],
      set: { ...device, lastSeenAt: sql`now()` },
    })
    .returning();

  await tx
    .delete(pushDevices)
    .where(
      and(
        eq(pushDevices.userId, userId),
        notInArray(
          pushDevices.token,
          tx
            .select({ token: pushDevices.token })
            .from(pushDevices)
            .where(eq(pushDevices.userId, userId))
            .orderBy(desc(pushDevices.lastSeenAt), desc(pushDevices.token))
            .limit(PUSH_DEVICES_PER_USER_MAX),
        ),
      ),
    );
  return row;
};

/** Unregister a device on sign-out. False when it was not registered. */
export const unregisterPushDevice = async (
  tx: Pick<Transaction, "delete">,
  { token, userId }: { token: string; userId: SafeId<"user"> },
): Promise<boolean> => {
  // audit: skip - the person's own alert delivery address, holding no content
  const removed = await tx
    .delete(pushDevices)
    .where(and(eq(pushDevices.userId, userId), eq(pushDevices.token, token)))
    .returning({ token: pushDevices.token });
  return removed.length > 0;
};

export type DeliverableDevice = Pick<
  PushDeviceRow,
  "token" | "environment" | "bundleId" | "locale"
> & {
  /** The registration as read, at full precision, to remove it only if unchanged. */
  seenToken: TimestampCasToken;
};

const laterClaim = alias(pushDevices, "later_claim");

/**
 * The devices to alert for a person's notification in one organization.
 *
 * A token identifies an app install, not a person: when somebody else signs
 * in on the same phone and registers it, their claim is the live one, and
 * this person's older row must not keep alerting a phone they no longer use.
 * Telling the two apart needs both people's rows, so this reads through the
 * owner connection; the recipient and organization it is given come from the
 * notification row, never from the job.
 *
 * Registration keeps a person to {@link PUSH_DEVICES_PER_USER_MAX} devices,
 * but two registrations racing each other can leave more until the next one
 * trims them; the read then reports the overflow instead of a partial list.
 */
export const listDeliverableDevices = async (
  db: Pick<Transaction, "select">,
  {
    organizationId,
    userId,
  }: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
): Promise<BoundedReadResult<DeliverableDevice>> =>
  await readBounded(
    db
      .select({
        token: pushDevices.token,
        environment: pushDevices.environment,
        bundleId: pushDevices.bundleId,
        locale: pushDevices.locale,
        seenToken: timestampCasToken(pushDevices.lastSeenAt),
      })
      .from(pushDevices)
      .where(
        and(
          eq(pushDevices.userId, userId),
          eq(pushDevices.organizationId, organizationId),
          notExists(
            db
              .select({ token: laterClaim.token })
              .from(laterClaim)
              .where(
                and(
                  eq(laterClaim.token, pushDevices.token),
                  ne(laterClaim.userId, pushDevices.userId),
                  // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- column against column inside one statement; no JS Date is bound
                  gt(laterClaim.lastSeenAt, pushDevices.lastSeenAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(pushDevices.lastSeenAt)),
    PUSH_DEVICES_PER_USER_MAX,
  );

/**
 * Remove devices APNs called dead. Each is removed only if it has not been
 * registered again since it was read, so a reinstall that raced the failed
 * send keeps its fresh row.
 */
export const removeDeadPushDevices = async (
  db: Pick<Transaction, "delete">,
  {
    devices,
    userId,
  }: {
    devices: readonly Pick<DeliverableDevice, "token" | "seenToken">[];
    userId: SafeId<"user">;
  },
): Promise<number> => {
  if (devices.length === 0) {
    return 0;
  }
  // audit: skip - the gateway reported these delivery addresses permanently dead
  const removed = await db
    .delete(pushDevices)
    .where(
      and(
        eq(pushDevices.userId, userId),
        or(
          ...devices.map((device) =>
            and(
              eq(pushDevices.token, device.token),
              timestampMatchesCasToken(
                pushDevices.lastSeenAt,
                device.seenToken,
              ),
            ),
          ),
        ),
      ),
    )
    .returning({ token: pushDevices.token });
  return removed.length;
};
