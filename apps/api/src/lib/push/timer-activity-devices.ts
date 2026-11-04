import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { timingSafeEqual } from "node:crypto";

import {
  TIMER_ACTIVITY_ACTION_KEY_HOURS,
  TIMER_ACTIVITY_DEVICES_PER_USER_MAX,
} from "@stll/api-contract/timer-activity";
import type {
  TimerActivityActionKey,
  TimerActivityDeviceRegistration,
} from "@stll/api-contract/timer-activity";

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
import {
  createOpaqueToken,
  hashOpaqueToken,
  isOpaqueTokenShape,
} from "@/api/lib/entities/opaque-tokens";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { requireSessionCredentialIssuer } from "@/api/lib/synthetic-principal/credential-policy";
import type { CredentialPrincipal } from "@/api/lib/synthetic-principal/credential-policy";

type DeviceWriteTx = Pick<Transaction, "insert" | "select" | "delete">;

/**
 * A phone not heard from in this long is sent nothing more: the app files
 * its state every time it opens, so only a phone that signed out without
 * reaching the server, or stopped using the app, goes this quiet.
 */
const TIMER_ACTIVITY_DEVICE_QUIET_DAYS = 14;

/**
 * How long a start the server sent holds before another may be sent. The app
 * reports the started activity when iOS wakes it for the activity's token; a
 * start it never reports, or one interrupted before it reached Apple, is
 * given up after this long, which is as long as iOS lets an activity run, so
 * a second start never joins a first still on the Lock Screen.
 */
const TIMER_ACTIVITY_START_HOLD_HOURS = 8;

/**
 * File what a phone holds now. The app sends its whole state each time, so
 * the row is replaced, not merged, but only by a newer registration and
 * only while its sign-in lasts: one that arrives late, after a newer one or
 * after the sign-out, changes nothing. A registration also forgets that the
 * server started an activity here, since the app now reports what it shows.
 * Past {@link TIMER_ACTIVITY_DEVICES_PER_USER_MAX} the signed-in rows seen
 * longest ago are dropped. A sign-out's mark is kept for two weeks, longer
 * than any registration can be on its way, and as long as a silent phone is
 * still sent anything.
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
    sequence: registration.sequence,
  };
  // audit: skip - the person's own phone address for their timer, holding no content
  await tx
    .insert(timerActivityDevices)
    .values({ ...device, userId, deviceId })
    .onConflictDoUpdate({
      target: [timerActivityDevices.userId, timerActivityDevices.deviceId],
      set: { ...device, lastSeenAt: sql`now()` },
      setWhere: sql`${timerActivityDevices.signedOutAt} IS NULL AND ${timerActivityDevices.sequence} < excluded.sequence`,
    });

  await tx.delete(timerActivityDevices).where(
    and(
      eq(timerActivityDevices.userId, userId),
      // sql-perf-allow: bounded by one person's own rows, reached by the primary key's leading user_id
      or(
        sql`${timerActivityDevices.signedOutAt} < now() - make_interval(days => ${TIMER_ACTIVITY_DEVICE_QUIET_DAYS})`,
        and(
          isNull(timerActivityDevices.signedOutAt),
          notInArray(
            timerActivityDevices.deviceId,
            tx
              .select({ deviceId: timerActivityDevices.deviceId })
              .from(timerActivityDevices)
              .where(
                and(
                  eq(timerActivityDevices.userId, userId),
                  isNull(timerActivityDevices.signedOutAt),
                ),
              )
              .orderBy(
                desc(timerActivityDevices.lastSeenAt),
                desc(timerActivityDevices.deviceId),
              )
              .limit(TIMER_ACTIVITY_DEVICES_PER_USER_MAX),
          ),
        ),
      ),
    ),
  );
};

/**
 * Sign a phone out: its row is kept, marked, so a registration still in
 * flight cannot bring it back and it still outranks older sign-ins on the
 * same phone. False when it was not registered or already signed out.
 */
export const unregisterTimerActivityDevice = async (
  tx: Pick<Transaction, "update">,
  { deviceId, userId }: { deviceId: string; userId: SafeId<"user"> },
): Promise<boolean> => {
  // audit: skip - the person's own phone address for their timer, holding no content
  const signedOut = await tx
    .update(timerActivityDevices)
    // The claim time stays: a late sign-out of an older sign-in must not
    // outrank a newer one on the same phone.
    .set({
      signedOutAt: sql`now()`,
      actionKeyHash: null,
      actionKeyExpiresAt: null,
    })
    .where(
      and(
        eq(timerActivityDevices.userId, userId),
        eq(timerActivityDevices.deviceId, deviceId),
        isNull(timerActivityDevices.signedOutAt),
      ),
    )
    .returning({ deviceId: timerActivityDevices.deviceId });
  return signedOut.length > 0;
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
> & {
  /** Whether a start the server sent still holds, so no other may be sent. */
  starting: boolean;
  /** Whether the phone holds a live key its Lock Screen buttons can act with. */
  actions: boolean;
  /** The registration as read, at full precision, to change it only if unchanged. */
  seenToken: TimestampCasToken;
};

const laterClaim = alias(timerActivityDevices, "later_claim");

const sharesToken = (column: "startToken" | "activityToken") =>
  and(
    isNotNull(timerActivityDevices[column]),
    or(
      eq(laterClaim.startToken, timerActivityDevices[column]),
      eq(laterClaim.activityToken, timerActivityDevices[column]),
    ),
  );

const actionKeyLive = sql<boolean>`coalesce(${timerActivityDevices.actionKeyExpiresAt} > now(), false)`;

const startHolds = sql<boolean>`coalesce(${timerActivityDevices.startedAt} > now() - make_interval(hours => ${TIMER_ACTIVITY_START_HOLD_HOURS}), false)`;

/**
 * The phones to update for a person's timers in one organization.
 *
 * Apple's tokens name a phone, not a person: when a later sign-in on the
 * same phone (somebody else's, or the same person's again) registered the
 * same tokens, its claim is the live one, signed out or not, and this
 * older row must not keep drawing a timer there. Telling them apart needs
 * other people's rows, so this reads through the owner connection; the
 * person and organization come from the job, which the timer write that
 * queued it named. A signed-out row, or one not heard from in two weeks,
 * is sent nothing.
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
        starting: startHolds,
        actions: actionKeyLive,
        seenToken: timestampCasToken(timerActivityDevices.lastSeenAt),
      })
      .from(timerActivityDevices)
      .where(
        and(
          eq(timerActivityDevices.userId, userId),
          eq(timerActivityDevices.organizationId, organizationId),
          isNull(timerActivityDevices.signedOutAt),
          sql`${timerActivityDevices.lastSeenAt} > now() - make_interval(days => ${TIMER_ACTIVITY_DEVICE_QUIET_DAYS})`,
          notExists(
            db
              .select({ deviceId: laterClaim.deviceId })
              .from(laterClaim)
              .where(
                and(
                  or(
                    ne(laterClaim.userId, timerActivityDevices.userId),
                    ne(laterClaim.deviceId, timerActivityDevices.deviceId),
                  ),
                  or(sharesToken("startToken"), sharesToken("activityToken")),
                  // Column against column inside one statement, at full
                  // precision: no JS Date is bound.
                  sql`${laterClaim.lastSeenAt} > ${timerActivityDevices.lastSeenAt}::timestamptz`,
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
    isNull(timerActivityDevices.signedOutAt),
    timestampMatchesCasToken(timerActivityDevices.lastSeenAt, device.seenToken),
  );

/**
 * Claim the start of an activity on a phone: true for the one update that
 * may start it, false when another start still holds or the phone
 * registered since. The claim holds until the app next reports what it
 * shows, or for half an hour.
 */
export const claimTimerActivityStart = async (
  db: Pick<Transaction, "update">,
  ref: DeviceRef,
): Promise<boolean> => {
  // audit: skip - delivery bookkeeping on the person's own phone address
  const claimed = await db
    .update(timerActivityDevices)
    .set({ startedAt: sql`now()` })
    .where(and(unchanged(ref), sql`NOT ${startHolds}`))
    .returning({ deviceId: timerActivityDevices.deviceId });
  return claimed.length > 0;
};

/** Give a start claim back after Apple refused the start. */
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
 * unless the phone registered again since it was read. An activity that is
 * gone also gives back any start claim, so the next running timer may start
 * another.
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
        : { activityId: null, activityToken: null, startedAt: null },
    )
    .where(unchanged(ref));
};

/**
 * The secret half of a Lock Screen button key. It is a credential that acts
 * for the person without their session, so the review account never gets
 * one.
 */
export const createTimerActivityActionKeySecret = (
  principal: CredentialPrincipal,
): string => {
  requireSessionCredentialIssuer("timerActivity", principal);
  return createOpaqueToken();
};

export const hashTimerActivityActionKey = hashOpaqueToken;

/**
 * Give a signed-in phone a new key for its Lock Screen buttons, replacing
 * any it held. The key is shown here once; only its SHA-256 is kept. Null
 * when the phone is not registered under this sign-in, or has signed out.
 */
export const issueTimerActivityActionKey = async (
  tx: Pick<Transaction, "update">,
  {
    deviceId,
    organizationId,
    userId,
  }: {
    deviceId: string;
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  },
): Promise<TimerActivityActionKey | null> => {
  const secret = createTimerActivityActionKeySecret({ userId, organizationId });
  const keyHash = hashTimerActivityActionKey(secret);
  // audit: skip - the person's own phone key for their own timers; using it is audited
  const [row] = await tx
    .update(timerActivityDevices)
    .set({
      actionKeyHash: keyHash,
      actionKeyExpiresAt: sql`now() + make_interval(hours => ${TIMER_ACTIVITY_ACTION_KEY_HOURS})`,
    })
    .where(
      and(
        eq(timerActivityDevices.userId, userId),
        eq(timerActivityDevices.deviceId, deviceId),
        eq(timerActivityDevices.organizationId, organizationId),
        isNull(timerActivityDevices.signedOutAt),
      ),
    )
    .returning({ expiresAt: timerActivityDevices.actionKeyExpiresAt });
  const expiresAt = row?.expiresAt ?? null;
  return expiresAt === null
    ? null
    : { key: `${userId}.${secret}`, expiresAt: expiresAt.toISOString() };
};

const ACTION_KEY_MAX_LENGTH = 200;

/**
 * The person and organization a Lock Screen button key acts for, or null for
 * a key that is malformed, unknown, expired or from a signed-out phone.
 * Reads through the owner connection: the key is the only credential the
 * request carries, so no person is known before this answers.
 */
export const verifyTimerActivityActionKey = async (
  db: Pick<Transaction, "select">,
  { deviceId, key }: { deviceId: string; key: string },
): Promise<{
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
} | null> => {
  if (key.length > ACTION_KEY_MAX_LENGTH) {
    return null;
  }
  const separator = key.lastIndexOf(".");
  const userId = key.slice(0, separator);
  const secret = key.slice(separator + 1);
  if (separator < 1 || !isOpaqueTokenShape(secret)) {
    return null;
  }
  const [row] = await db
    .select({
      organizationId: timerActivityDevices.organizationId,
      actionKeyHash: timerActivityDevices.actionKeyHash,
    })
    .from(timerActivityDevices)
    .where(
      and(
        eq(timerActivityDevices.userId, userId),
        eq(timerActivityDevices.deviceId, deviceId),
        isNull(timerActivityDevices.signedOutAt),
        actionKeyLive,
      ),
    )
    .limit(1);
  const storedHash = row?.actionKeyHash ?? null;
  if (row === undefined || storedHash === null) {
    return null;
  }
  const presented = Buffer.from(hashTimerActivityActionKey(secret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (
    presented.length !== stored.length ||
    !timingSafeEqual(presented, stored)
  ) {
    return null;
  }
  return {
    organizationId: brandPersistedOrganizationId(row.organizationId),
    userId: brandPersistedUserId(userId),
  };
};
