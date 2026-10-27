import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import { organization, user } from "@/api/db/auth-schema";
import { timestamptz } from "@/api/db/columns";
import { denyStellaAccessPolicies } from "@/api/db/rls";

/** OAuth grants disconnected while a signed access token may still be live. */
export const oauthGrantRevocations = pgTable(
  "oauth_grant_revocations",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    oauthClientId: text("oauth_client_id").notNull(),
    grantId: text("grant_id"),
    revokedAt: timestamptz("revoked_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.userId, table.oauthClientId],
      name: "oauth_grant_revocations_pk",
    }),
    index("oauth_grant_revocations_user_revoked_at_idx").on(
      table.userId,
      table.revokedAt,
    ),
    ...denyStellaAccessPolicies(),
  ],
);
