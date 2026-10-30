import { panic } from "better-result";
import { getColumnTable, getTableName, is, sql } from "drizzle-orm";
import { pgPolicy, PgTable } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { MEMBER_REMOVAL_SETTING } from "./member-removal-settings";
import { MEMBER_EXCHANGE_OFFBOARDING_ROLE_NAME } from "./role-names";

type MemberExchangeColumns = {
  createdBy: AnyPgColumn;
  workspaceId: AnyPgColumn;
};

/** Reads and deletes share the locked member and matter predicate. */
export const memberExchangeOffboardingPolicies = ({
  createdBy,
  workspaceId,
}: MemberExchangeColumns) => {
  const table: unknown = getColumnTable(createdBy);
  const tableName = is(table, PgTable)
    ? getTableName(table)
    : panic("Exchange policies require Postgres table columns");
  const target =
    sql`${createdBy} = nullif(current_setting(${MEMBER_REMOVAL_SETTING.userId}, true), '')
    AND ${workspaceId} = ANY(coalesce(nullif(current_setting('app.workspace_ids', true), ''), '{}')::uuid[])
    AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = ${workspaceId} AND w.organization_id = nullif(current_setting('app.organization_id', true), ''))
    AND EXISTS (SELECT 1 FROM public.member m WHERE m.id = nullif(current_setting(${MEMBER_REMOVAL_SETTING.memberId}, true), '') AND m.organization_id = nullif(current_setting('app.organization_id', true), '') AND m.user_id = nullif(current_setting(${MEMBER_REMOVAL_SETTING.userId}, true), ''))`.inlineParams();
  return (["select", "delete"] as const).map((operation) =>
    pgPolicy(`${tableName}_member_exchange_${operation}`, {
      for: operation,
      to: MEMBER_EXCHANGE_OFFBOARDING_ROLE_NAME,
      using: target,
    }),
  );
};
