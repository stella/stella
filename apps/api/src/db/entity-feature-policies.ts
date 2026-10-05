import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";

import { APPLICATION_RLS_ROLE_NAME } from "./role-names";

/** All workspace-bound entity readers and writers inherit the same feature fence. */
export const entityFeaturePolicies = (
  columns: Record<string, AnyPgColumn>,
  references: ReadonlyMap<
    AnyPgColumn,
    "entities" | "entity_versions" | "fields"
  > = new Map(),
) => {
  const conditions: SQL[] = [];
  const root = Object.values(columns).find(
    (column) => column.name === "list_item_type",
  );
  const candidates = root === undefined ? [...references.keys()] : [root];
  for (const column of candidates) {
    if (column.name === "list_item_type") {
      conditions.push(
        sql`(${column} IS NULL OR ${column} = 'task' OR coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? ${LEGAL_LISTS_FEATURE_ID})`,
      );
      continue;
    }
    if (references.get(column) === "entities") {
      conditions.push(
        sql`(CASE WHEN ${column} IS NULL THEN true ELSE EXISTS (SELECT 1 FROM public.entities e WHERE e.id = ${column}) END)`,
      );
      continue;
    }
    if (references.get(column) === "entity_versions") {
      conditions.push(
        sql`(CASE WHEN ${column} IS NULL THEN true ELSE EXISTS (SELECT 1 FROM public.entity_versions v WHERE v.id = ${column}) END)`,
      );
      continue;
    }
    if (references.get(column) === "fields") {
      conditions.push(
        sql`(CASE WHEN ${column} IS NULL THEN true ELSE EXISTS (SELECT 1 FROM public.fields f WHERE f.id = ${column}) END)`,
      );
    }
  }
  if (conditions.length === 0) {
    return [];
  }
  const fence = sql.join(conditions, sql` AND `);
  return [
    pgPolicy("workspace_entity_feature", {
      as: "restrictive",
      for: "all",
      to: APPLICATION_RLS_ROLE_NAME,
      using: fence,
      withCheck: fence,
    }),
  ];
};
