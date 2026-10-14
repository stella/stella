import { panic } from "better-result";
import { getTableName, sql } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { stellaSystem } from "@/api/db/rls";

/** System permissions remain bounded by the row organization and explicit matter set. */
export const systemScopePolicies = (
  columns: Record<string, AnyPgColumn>,
  access: "read" | "write" = "write",
) => {
  const entries = Object.values(columns);
  const first = entries.at(0) ?? panic("System scope requires table columns");
  const tableName = getTableName(first.table);
  const organization = entries.find(
    (column) => column.name === "organization_id",
  );
  const workspace =
    tableName === "workspaces"
      ? entries.find((column) => column.name === "id")
      : entries.find((column) => column.name === "workspace_id");
  const organizationId = (() => {
    if (tableName === "organization") {
      return sql`id`;
    }
    if (organization !== undefined) {
      return sql`${sql.identifier(organization.name)}`;
    }
    if (workspace !== undefined) {
      return sql`(SELECT scope_workspace.organization_id FROM public.workspaces scope_workspace WHERE scope_workspace.id = ${sql.identifier(workspace.name)})`;
    }
    return panic("System scope requires organization ownership");
  })();
  const matter = (() => {
    if (tableName === "signal_events") {
      return sql`EXISTS (SELECT 1 FROM public.signals scope_signal WHERE scope_signal.id = signal_id)`;
    }
    if (workspace === undefined) {
      return sql`true`;
    }
    return sql`(${sql.identifier(workspace.name)} IS NULL OR ${sql.identifier(workspace.name)} = ANY(coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}')))`;
  })();
  const check = sql`${organizationId} = nullif(current_setting('app.organization_id', true), '') AND ${matter}`;
  return [
    pgPolicy("organization_system_access", {
      for: access === "read" ? "select" : "all",
      to: stellaSystem,
      using: check,
      ...(access === "read" ? {} : { withCheck: check }),
    }),
    pgPolicy("organization_system_scope", {
      as: "restrictive",
      for: "all",
      to: stellaSystem,
      using: check,
      withCheck: check,
    }),
  ];
};

/** Identity reads use the current organization membership as their source. */
export const systemUserReadPolicies = () => [
  pgPolicy("user_system_select", {
    for: "select",
    to: stellaSystem,
    using: sql`EXISTS (SELECT 1 FROM public.member scope_member WHERE scope_member.user_id = "user".id AND scope_member.organization_id = nullif(current_setting('app.organization_id', true), ''))`,
  }),
];
