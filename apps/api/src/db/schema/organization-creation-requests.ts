import { sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

import { organization, user } from "@/api/db/auth-schema";
import { timestamptz } from "@/api/db/columns";
import type { SafeId } from "@/api/lib/branded-types";

/** Account-owned receipts work before the caller has an organization. */
export const organizationCreationRequests = p.pgTable.withRLS(
  "organization_creation_requests",
  {
    userId: p
      .text("user_id")
      .$type<SafeId<"user">>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: p.text("key").notNull(),
    fingerprint: p.text("fingerprint").notNull(),
    organizationId: p
      .text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" }),
    name: p.text("name"),
    slug: p.text("slug"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({ columns: [table.userId, table.key] }),
    p.index("organization_creation_requests_org_idx").on(table.organizationId),
    p.check(
      "organization_creation_requests_result_check",
      sql`(${table.organizationId} IS NULL AND ${table.name} IS NULL AND ${table.slug} IS NULL) OR (${table.organizationId} IS NOT NULL AND ${table.name} IS NOT NULL AND ${table.slug} IS NOT NULL)`,
    ),
    p.pgPolicy("organization_creation_requests_owner", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_creation_requests'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_creation_requests'::regclass)`,
    }),
  ],
);
