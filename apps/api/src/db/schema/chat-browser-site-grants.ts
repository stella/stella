import { sql } from "drizzle-orm";

import { BROWSER_SITE_GRANT_ORIGIN_CHARS } from "@stll/api-contract/browser-site-grants";

import {
  chatBrowserSiteGrantPolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  timestamptz,
  user,
} from "./common";

/**
 * A user's standing approval for chat's browser actions on one website,
 * keyed by its exact HTTPS origin. The API never lifts the `use-browser`
 * approval gate for it: the user's own browser applies it when it answers an
 * approval card, against the page the extension reported.
 */
export const chatBrowserSiteGrants = p.pgTable(
  "chat_browser_site_grants",
  {
    id: pUuid<"chatBrowserSiteGrant">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Exact origin (`https://host[:port]`) the grant covers. */
    origin: p
      .varchar("origin", { length: BROWSER_SITE_GRANT_ORIGIN_CHARS })
      .notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    // One grant per site; storing it again is a no-op. Also serves the
    // per-user listing, which filters on the leading columns.
    p
      .unique("chat_browser_site_grants_origin_key")
      .on(table.organizationId, table.userId, table.origin),
    p.check(
      "chat_browser_site_grants_https_origin_check",
      sql`${table.origin} LIKE 'https://%'`,
    ),
    ...chatBrowserSiteGrantPolicies(),
  ],
);
