import { SELF_SERVE_FEATURE_IDS } from "@/api/lib/feature-access/registry";

import {
  organization,
  p,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
  userOrganizationPolicies,
} from "./common";

const ownerCheck = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.feature_enrolments'::regclass)`;

export const featureEnrolments = p.pgTable.withRLS(
  "feature_enrolments",
  {
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    featureId: p.text("feature_id", { enum: SELF_SERVE_FEATURE_IDS }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.userId, table.organizationId, table.featureId],
    }),
    p.index("feature_enrolments_organization_idx").on(table.organizationId),
    p.check(
      "feature_enrolments_feature_id_check",
      sql`${table.featureId} IN (${sql.join(
        SELF_SERVE_FEATURE_IDS.map((id) => sql.raw(`'${id}'`)),
        sql`, `,
      )})`,
    ),
    p.pgPolicy("feature_enrolments_owner", {
      for: "all",
      to: "public",
      using: ownerCheck,
      withCheck: ownerCheck,
    }),
    ...userOrganizationPolicies(),
  ],
);
