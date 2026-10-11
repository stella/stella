import { sql } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";

export const REVIEW_RESET_ORGANIZATION_SETTING =
  "app.correspondence_review_reset_organization_id";

/** Owner cleanup is fenced to the reset organization, independently of member visibility. */
export const reviewResetOwnerCheck = (
  tableName: string,
) => sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = ${sql.raw(`'public.${tableName}'::regclass`)})
    AND organization_id = nullif(current_setting('${sql.raw(REVIEW_RESET_ORGANIZATION_SETTING)}', true), '')`;

export const reviewResetOwnerPolicies = (tableName: string) => {
  const scope = reviewResetOwnerCheck(tableName);
  return [
    pgPolicy("review_reset_owner_select", { for: "select", using: scope }),
    pgPolicy("review_reset_owner_delete", { for: "delete", using: scope }),
  ];
};
