import {
  APNS_ENVIRONMENTS,
  MOBILE_APP_BUNDLE_IDS,
  PUSH_DEVICE_PLATFORMS,
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

const tableOwner = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.push_devices'::regclass)`;

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

/**
 * A device the stella mobile app runs on, registered by the person signed in
 * to it so their notifications can reach it as alerts.
 *
 * One row per person and device token. The row names the organization the
 * app is signed in to; signing in to another firm on the same device moves
 * the row rather than adding one, so a phone only ever alerts for the firm it
 * shows. Alerts carry no content (see `lib/push`), and a token the gateway
 * reports dead is deleted when it does.
 *
 * Row security admits a person to their own rows only. Delivery reads the
 * table through the owner connection, which is the only place a device
 * claimed later by somebody else is told apart from a live one; row security
 * is forced, so that role is admitted by name.
 */
export const pushDevices = p.pgTable(
  "push_devices",
  {
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The firm the app is signed in to on this device. */
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    platform: p.text("platform", { enum: PUSH_DEVICE_PLATFORMS }).notNull(),
    /** The APNs device token, lowercase hex. */
    token: p.text("token").notNull(),
    /** Which APNs gateway accepts the token. */
    environment: p.text("environment", { enum: APNS_ENVIRONMENTS }).notNull(),
    /** The app build that registered, and so the APNs topic. */
    bundleId: p.text("bundle_id", { enum: MOBILE_APP_BUNDLE_IDS }).notNull(),
    appVersion: p.text("app_version").notNull(),
    /** The device's language as a BCP 47 tag; alert text is chosen from it. */
    locale: p.text("locale").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /** Last registration or refresh; the oldest device is evicted first. */
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({ columns: [table.userId, table.token] }),
    p.index("push_devices_user_org_idx").on(table.userId, table.organizationId),
    // Delivery skips a token somebody else registered more recently.
    p.index("push_devices_token_idx").on(table.token),
    p.check(
      "push_devices_platform_check",
      sql`${table.platform} IN (${sqlValues(PUSH_DEVICE_PLATFORMS)})`,
    ),
    p.check(
      "push_devices_environment_check",
      sql`${table.environment} IN (${sqlValues(APNS_ENVIRONMENTS)})`,
    ),
    p.check(
      "push_devices_bundle_id_check",
      sql`${table.bundleId} IN (${sqlValues(MOBILE_APP_BUNDLE_IDS)})`,
    ),
    p.check(
      "push_devices_token_check",
      sql`${table.token} ~ '^([0-9a-f]{2}){32,100}$'`,
    ),
    p.check(
      "push_devices_app_version_check",
      sql`char_length(${table.appVersion}) BETWEEN 1 AND 64`,
    ),
    p.check(
      "push_devices_locale_check",
      sql`char_length(${table.locale}) BETWEEN 2 AND 35`,
    ),
    ...userPolicies(),
    p.pgPolicy("push_devices_owner", {
      for: "all",
      to: "public",
      using: tableOwner,
      withCheck: tableOwner,
    }),
  ],
);

export type PushDeviceRow = typeof pushDevices.$inferSelect;
