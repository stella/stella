import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getTableConfig, pgPolicy, PgDialect } from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { compareCodeUnit } from "@stll/collation";

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

/** The migration and its parity check render the schema owner's actual policies. */
export const entityFeaturePolicyStatements = (
  tables: readonly PgTable[],
): string[] => {
  const dialect = new PgDialect();
  return tables
    .map(getTableConfig)
    .toSorted((left, right) => compareCodeUnit(left.name, right.name))
    .flatMap((config) =>
      config.policies.flatMap((policy) => {
        if (
          policy.name !== "workspace_entity_feature" ||
          policy.using === undefined ||
          policy.withCheck === undefined
        ) {
          return [];
        }
        return [
          dialect
            .sqlToQuery(
              sql`
        CREATE POLICY ${sql.identifier(policy.name)}
        ON ${sql.identifier(config.schema ?? "public")}.${sql.identifier(config.name)}
        AS RESTRICTIVE FOR ALL TO ${sql.identifier(APPLICATION_RLS_ROLE_NAME)}
        USING (${policy.using}) WITH CHECK (${policy.withCheck});
      `.inlineParams(),
            )
            .sql.trim()
            .replace(/\s+/gu, " "),
        ];
      }),
    );
};
