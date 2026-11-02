import { sql } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";

export const ACCOUNT_ERASURE_USER_SETTING = "app.account_erasure_user_id";

/** Table-owner access is limited to private rows owned by the erasing account. */
export const accountErasureOwnerPolicies = (tableName: string) => {
  const scope = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = ${sql.raw(`'public.${tableName}'::regclass`)})
    AND user_id = nullif(current_setting('${sql.raw(ACCOUNT_ERASURE_USER_SETTING)}', true), '')
    AND visibility = 'private'`;
  return [
    pgPolicy("account_erasure_owner_select", { for: "select", using: scope }),
    pgPolicy("account_erasure_owner_delete", { for: "delete", using: scope }),
  ];
};
