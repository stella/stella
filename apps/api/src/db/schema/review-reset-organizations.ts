import { REVIEW_RESET_ROLE_NAME } from "../role-names";
import { p, sql } from "./common";

/** Reset authority is registered by the migration owner, independently of app state. */
export const reviewResetOrganizations = p.pgTable.withRLS(
  "review_reset_organizations",
  { organizationId: p.text("organization_id").primaryKey() },
  (table) => [
    p.pgPolicy("review_reset_registry_owner", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.review_reset_organizations'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.review_reset_organizations'::regclass)`,
    }),
    p.pgPolicy("review_reset_registry_select", {
      for: "select",
      to: REVIEW_RESET_ROLE_NAME,
      using: sql`${table.organizationId} = nullif(current_setting('app.organization_id', true), '')`,
    }),
  ],
);
