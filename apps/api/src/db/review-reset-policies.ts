import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";

import { REVIEW_RESET_ROLE_NAME } from "./role-names";

/** Only the migration owner registers reset targets; a session cannot admit one. */
export const registeredReviewResetPolicies = (organizationId: SQLWrapper) => {
  const scope = sql`${organizationId} = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (SELECT 1 FROM public.review_reset_organizations registered
      WHERE registered.organization_id = ${organizationId})`;
  return [
    pgPolicy("registered_review_reset_select", {
      for: "select",
      to: REVIEW_RESET_ROLE_NAME,
      using: scope,
    }),
    pgPolicy("registered_review_reset_delete", {
      for: "delete",
      to: REVIEW_RESET_ROLE_NAME,
      using: scope,
    }),
    pgPolicy("registered_review_reset_scope", {
      as: "restrictive",
      for: "all",
      to: REVIEW_RESET_ROLE_NAME,
      using: scope,
      withCheck: scope,
    }),
  ];
};

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
