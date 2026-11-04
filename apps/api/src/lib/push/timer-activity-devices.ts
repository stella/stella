import {
  and,
  desc,
  eq,
  gt,
  isNull,
  ne,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { TIMER_ACTIVITY_DEVICES_PER_USER_MAX } from "@stll/api-contract/timer-activity";
import type { TimerActivityDeviceRegistration } from "@stll/api-contract/timer-activity";

import type { Transaction } from "@/api/db/root";
import { timerActivityDevices } from "@/api/db/schema";
import type { TimerActivityDeviceRow } from "@/api/db/schema";
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
 * File what a phone holds now. The app sends its whole state each time, so
 * the row is replaced, not merged; a registration also forgets that the
 * server started an activity here, since the app now reports what it shows.
 * Past {@link TIMER_ACTIVITY_DEVICES_PER_USER_MAX} the phones seen longest
 * ago are dropped.
 */
export const registerTimerActivityDevice = async (
  tx: DeviceWriteTx,
  {
    deviceId,
    organizationId,
    registration,
    userId,
  }: {
    deviceId: string;
    organizationId: SafeId<"organization">;
    registration: TimerActivityDeviceRegistration;
    userId: SafeId<"user">;
  },
): Promise<void> => {
  const device = {
    organizationId,
    environment: registration.environment,
    bundleId: registration.bundleId,
    locale: registration.locale,
    link: registration.link,
    details: registration.details,
    startToken: registration.startToken,
    activityId: registration.activity?.id ?? null,
    activityToken: registration.activity?.token ?? null,
    startedAt: null,
  };
  // audit: skip - the person's own phone address for their timer, holding no content
  await tx
    .insert(timerActivityDevices)
    .values({ ...device, userId, deviceId })
    .onConflictDoUpdate({
      target: [timerActivityDevices.userId, timerActivityDevices.deviceId],
      set: { ...device, lastSeenAt: sql`now()` },
    });

  await tx
    .delete(timerActivityDevices)
    .where(
      and(
        eq(timerActivityDevices.userId, userId),
        notInArray(
          timerActivityDevices.deviceId,
          tx
            .select({ deviceId: timerActivityDevices.deviceId })
            .from(timerActivityDevices)
            .where(eq(timerActivityDevices.userId, userId))
            .orderBy(
              desc(timerActivityDevices.lastSeenAt),
              desc(timerActivityDevices.deviceId),
            )
            .limit(TIMER_ACTIVITY_DEVICES_PER_USER_MAX),
        ),
      ),
    );
};

/** Forget a phone on sign-out. False when it was not registered. */
export const unregisterTimerActivityDevice = async (
  tx: Pick<Transaction, "delete">,
  { deviceId, userId }: { deviceId: string; userId: SafeId<"user"> },
): Promise<boolean> => {
  // audit: skip - the person's own phone address for their timer, holding no content
  const removed = await tx
    .delete(timerActivityDevices)
    .where(
      and(
        eq(timerActivityDevices.userId, userId),
        eq(timerActivityDevices.deviceId, deviceId),
      ),
    )
    .returning({ deviceId: timerActivityDevices.deviceId });
  return removed.length > 0;
};

export type TimerActivityDevice = Pick<
  TimerActivityDeviceRow,
  | "deviceId"
  | "environment"
  | "bundleId"
  | "locale"
  | "link"
  | "details"
  | "startToken"
  | "activityToken"
  | "startedAt"
> & {
  /** The registration as read, at full precision, to change it only if unchanged. */
  seenToken: TimestampCasToken;
};

const laterClaim = alias(timerActivityDevices, "later_claim");

/**
 * The phones to update for a person's timers in one organization.
 *
 * A device id names a phone, not a person: when somebody else signs in on
 * the same phone and registers it, their claim is the live one, and this
 * person's older row must not keep drawing their timer there. Telling the two
 * apart needs both people's rows, so this reads through the owner connection;
 * the person and organization come from the job, which the timer write that
 * queued it named.
 */
export const listTimerActivityDevices = async (
  db: Pick<Transaction, "select">,
  {
    organizationId,
    userId,
  }: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
): Promise<BoundedReadResult<TimerActivityDevice>> =>
  await readBounded(
    db
      .select({
        deviceId: timerActivityDevices.deviceId,
        environment: timerActivityDevices.environment,
        bundleId: timerActivityDevices.bundleId,
        locale: timerActivityDevices.locale,
        link: timerActivityDevices.link,
        details: timerActivityDevices.details,
        startToken: timerActivityDevices.startToken,
        activityToken: timerActivityDevices.activityToken,
        startedAt: timerActivityDevices.startedAt,
        seenToken: timestampCasToken(timerActivityDevices.lastSeenAt),
      })
      .from(timerActivityDevices)
      .where(
        and(
          eq(timerActivityDevices.userId, userId),
          eq(timerActivityDevices.organizationId, organizationId),
          notExists(
            db
              .select({ deviceId: laterClaim.deviceId })
              .from(laterClaim)
              .where(
                and(
                  eq(laterClaim.deviceId, timerActivityDevices.deviceId),
                  ne(laterClaim.userId, timerActivityDevices.userId),
                  // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- column against column inside one statement; no JS Date is bound
                  gt(laterClaim.lastSeenAt, timerActivityDevices.lastSeenAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(timerActivityDevices.lastSeenAt)),
    TIMER_ACTIVITY_DEVICES_PER_USER_MAX,
  );

type DeviceRef = {
  userId: SafeId<"user">;
  device: Pick<TimerActivityDevice, "deviceId" | "seenToken">;
};

const unchanged = ({ userId, device }: DeviceRef) =>
  and(
    eq(timerActivityDevices.userId, userId),
    eq(timerActivityDevices.deviceId, device.deviceId),
    timestampMatchesCasToken(timerActivityDevices.lastSeenAt, device.seenToken),
  );

/**
 * Claim the start of an activity on a phone: true for the one update that
 * may start it, false when another already did or the phone registered
 * since. The claim holds until the app next reports what it shows.
 */
export const claimTimerActivityStart = async (
  db: Pick<Transaction, "update">,
  ref: DeviceRef,
): Promise<boolean> => {
  // audit: skip - delivery bookkeeping on the person's own phone address
  const claimed = await db
    .update(timerActivityDevices)
    .set({ startedAt: sql`now()` })
    .where(and(unchanged(ref), isNull(timerActivityDevices.startedAt)))
    .returning({ deviceId: timerActivityDevices.deviceId });
  return claimed.length > 0;
};

/** Give a start claim back after Apple did not take the start. */
export const releaseTimerActivityStart = async (
  db: Pick<Transaction, "update">,
  ref: DeviceRef,
): Promise<void> => {
  // audit: skip - delivery bookkeeping on the person's own phone address
  await db
    .update(timerActivityDevices)
    .set({ startedAt: null })
    .where(unchanged(ref));
};

/**
 * Forget a token Apple called dead, or the activity the server just ended,
 * unless the phone registered again since it was read.
 */
export const forgetTimerActivityToken = async (
  db: Pick<Transaction, "update">,
  { token, ...ref }: DeviceRef & { token: "start" | "activity" },
): Promise<void> => {
  // audit: skip - delivery bookkeeping on the person's own phone address
  await db
    .update(timerActivityDevices)
    .set(
      token === "start"
        ? { startToken: null }
        : { activityId: null, activityToken: null },
    )
    .where(unchanged(ref));
};
