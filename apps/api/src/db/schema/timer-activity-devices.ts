import {
  APNS_ENVIRONMENTS,
  MOBILE_APP_BUNDLE_IDS,
} from "@stll/api-contract/mobile-push";

import {
  organization,
  p,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
  userPolicies,
} from "./common";

const tableOwner = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.timer_activity_devices'::regclass)`;

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

const PUSH_TOKEN_PATTERN = "^([0-9a-f]{2}){32,100}$";

/**
 * A phone that shows the person's running timer on its Lock Screen, so a
 * timer started, paused or saved on another device reaches it too.
 *
 * One row per sign-in on a phone, named by an id the app makes when it
 * signs in. The app sends its whole state each time it changes, numbered:
 * the token that starts an activity, the activity it shows and the token
 * that updates it, and whether the person lets updates name the timer's
 * description and matter. The row names the organization the app is signed
 * in to, and moves with it.
 *
 * Signing out keeps the row, marked, so a registration still in flight
 * cannot bring it back, and so it still counts as the phone's latest claim:
 * Apple's tokens name the phone, and an older sign-in that shares them is
 * never sent anything again.
 *
 * Row security admits a person to their own rows only. The update worker
 * reads the table through the owner connection, which is the only place a
 * phone claimed later by somebody else is told apart from a live one; row
 * security is forced, so that role is admitted by name.
 */
export const timerActivityDevices = p.pgTable(
  "timer_activity_devices",
  {
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The id the app made for this sign-in on the phone. */
    deviceId: p.uuid("device_id").notNull(),
    /** The firm the app is signed in to on this phone. */
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Which APNs gateway accepts the tokens. */
    environment: p.text("environment", { enum: APNS_ENVIRONMENTS }).notNull(),
    /** The app build that registered, and so the APNs topic. */
    bundleId: p.text("bundle_id", { enum: MOBILE_APP_BUNDLE_IDS }).notNull(),
    /** The app's language as a BCP 47 tag; the activity's words are chosen from it. */
    locale: p.text("locale").notNull(),
    /** The build's link to its timers, which a tap on the activity opens. */
    link: p.text("link").notNull(),
    /** Whether updates sent through Apple may name the timer's description and matter. */
    details: p.boolean("details").notNull(),
    /** The token that starts an activity on this phone; null before iOS 17.2. */
    startToken: p.text("start_token"),
    /** The activity the phone shows now; null when it shows none. */
    activityId: p.text("activity_id"),
    /** The token that updates or ends that activity. */
    activityToken: p.text("activity_token"),
    /** When the server last started an activity here, so it starts at most one until the app reports it. */
    startedAt: timestamptz("started_at"),
    /** The number of the registration filed; an older one changes nothing. */
    sequence: p.bigint("sequence", { mode: "number" }).notNull(),
    /** When this sign-in signed out; the row is then sent nothing and takes no registration. */
    signedOutAt: timestamptz("signed_out_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /** Last registration; the oldest phone is evicted first. */
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({ columns: [table.userId, table.deviceId] }),
    p
      .index("timer_activity_devices_user_org_idx")
      .on(table.userId, table.organizationId),
    // The update worker skips a phone a later sign-in registered, which
    // shares Apple's tokens with it.
    p.index("timer_activity_devices_start_token_idx").on(table.startToken),
    p
      .index("timer_activity_devices_activity_token_idx")
      .on(table.activityToken),
    p.check(
      "timer_activity_devices_environment_check",
      sql`${table.environment} IN (${sqlValues(APNS_ENVIRONMENTS)})`,
    ),
    p.check(
      "timer_activity_devices_bundle_id_check",
      sql`${table.bundleId} IN (${sqlValues(MOBILE_APP_BUNDLE_IDS)})`,
    ),
    p.check(
      "timer_activity_devices_locale_check",
      sql`char_length(${table.locale}) BETWEEN 2 AND 35`,
    ),
    p.check(
      "timer_activity_devices_link_check",
      sql`char_length(${table.link}) BETWEEN 1 AND 200`,
    ),
    p.check(
      "timer_activity_devices_start_token_check",
      sql`${table.startToken} ~ ${sql.raw(`'${PUSH_TOKEN_PATTERN}'`)}`,
    ),
    p.check(
      "timer_activity_devices_activity_token_check",
      sql`${table.activityToken} ~ ${sql.raw(`'${PUSH_TOKEN_PATTERN}'`)}`,
    ),
    p.check(
      "timer_activity_devices_sequence_check",
      sql`${table.sequence} >= 0`,
    ),
    p.check(
      "timer_activity_devices_activity_check",
      sql`(${table.activityId} IS NULL) = (${table.activityToken} IS NULL) AND char_length(${table.activityId}) BETWEEN 1 AND 128`,
    ),
    ...userPolicies(),
    p.pgPolicy("timer_activity_devices_owner", {
      for: "all",
      to: "public",
      using: tableOwner,
      withCheck: tableOwner,
    }),
  ],
);

export type TimerActivityDeviceRow = typeof timerActivityDevices.$inferSelect;
