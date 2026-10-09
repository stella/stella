import { panic } from "better-result";
import { getColumnTable, sql } from "drizzle-orm";
import type { SQL, GetColumnData, SQLWrapper } from "drizzle-orm";
import { getTableConfig, pgPolicy, PgDialect } from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { EntityContextReference } from "@stll/api-contract/entity-reference";
import { compareCodeUnit } from "@stll/collation";

import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";

import {
  APPLICATION_RLS_ROLE_NAME,
  ENTITY_FEATURE_GATE_ROLE_NAME,
} from "./role-names";

export type EntityReferenceClassification =
  | {
      target: "entities" | "entity_versions" | "fields";
      kind: "owned-content" | "context";
    }
  | {
      /** A dependent record shown only while its fenced parent row is visible. */
      kind: "owned-by-parent";
      parent: PgTable;
    };

// Schema callbacks and FK metadata use distinct column objects for the same column.
const entityReferences = new WeakMap<
  PgTable,
  Map<string, EntityReferenceClassification>
>();

export const entityReferenceClassification = (column: AnyPgColumn) =>
  entityReferences.get(getColumnTable<PgTable>(column))?.get(column.name);

export type { EntityContextReference };

/** Retains the source classification when a relational query aliases its columns. */
export const entityContextProjection = <TColumn extends AnyPgColumn>(
  source: TColumn,
) => {
  // Drizzle evaluates the schema callback lazily, including its reference classifications.
  getTableConfig(getColumnTable<PgTable>(source));
  const classification = entityReferenceClassification(source);
  if (classification?.kind !== "context") {
    return panic("Context projection requires a classified context reference");
  }
  const visibility = (column: SQLWrapper) =>
    sql`EXISTS (SELECT 1 FROM ${sql.identifier("public")}.${sql.identifier(classification.target)} context_resource WHERE context_resource.id = ${column})`;
  return {
    id: (column: SQLWrapper) =>
      sql<GetColumnData<TColumn> | null>`CASE WHEN ${visibility(column)} THEN ${column} ELSE NULL END`,
    reference: (column: SQLWrapper) =>
      sql<EntityContextReference>`CASE WHEN ${column} IS NULL THEN NULL WHEN ${visibility(column)} THEN jsonb_build_object('type', 'available', 'id', ${column}) ELSE jsonb_build_object('type', 'unavailable') END`,
  };
};

export const entityContextId = <TColumn extends AnyPgColumn>(column: TColumn) =>
  entityContextProjection(column).id(column);

export const entityContextReference = (column: AnyPgColumn) =>
  entityContextProjection(column).reference(column);

/** All workspace-bound entity readers and writers inherit the same feature fence. */
export const entityFeaturePolicies = (
  columns: Record<string, AnyPgColumn>,
  references: ReadonlyMap<
    AnyPgColumn,
    EntityReferenceClassification
  > = new Map(),
) => {
  for (const [column, classification] of references) {
    let tableReferences = entityReferences.get(getColumnTable<PgTable>(column));
    if (tableReferences === undefined) {
      tableReferences = new Map();
      entityReferences.set(getColumnTable<PgTable>(column), tableReferences);
    }
    tableReferences.set(column.name, classification);
  }
  const conditions: SQL[] = [];
  const root = Object.values(columns).find(
    (column) => column.name === "list_item_type",
  );
  const candidates = root === undefined ? [...references.keys()] : [root];
  for (const column of candidates) {
    if (column.name === "list_item_type") {
      conditions.push(
        sql`((SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? ${LEGAL_LISTS_FEATURE_ID}) OR ${column} IS NULL OR ${column} = 'task')`,
      );
      continue;
    }
    const classification = references.get(column);
    if (classification?.kind === "owned-by-parent") {
      // Policy subqueries run as the querying role, and `stella` owns no table, so
      // the parent's own policies (its feature fence included) decide whether the
      // parent row exists here; visibility therefore follows chains of parents.
      const parent = getTableConfig(classification.parent);
      conditions.push(
        sql`(CASE WHEN ${column} IS NULL THEN true ELSE EXISTS (SELECT 1 FROM ${sql.identifier(parent.schema ?? "public")}.${sql.identifier(parent.name)} parent_row WHERE parent_row.id = ${column}) END)`,
      );
      continue;
    }
    if (classification?.kind !== "owned-content") {
      continue;
    }
    if (classification.target === "entities") {
      conditions.push(
        sql`(CASE WHEN ${column} IS NULL THEN true ELSE EXISTS (SELECT 1 FROM public.entities e WHERE e.id = ${column}) END)`,
      );
      continue;
    }
    if (classification.target === "entity_versions") {
      conditions.push(
        sql`(CASE WHEN ${column} IS NULL THEN true ELSE EXISTS (SELECT 1 FROM public.entity_versions v WHERE v.id = ${column}) END)`,
      );
      continue;
    }
    conditions.push(
      sql`(CASE WHEN ${column} IS NULL THEN true ELSE EXISTS (SELECT 1 FROM public.fields f WHERE f.id = ${column}) END)`,
    );
  }
  if (conditions.length === 0) {
    return [];
  }
  const gate = Object.values(columns).find(
    (column) => column.name === "entity_feature_gate",
  );
  if (root === undefined && gate !== undefined && conditions.length > 0) {
    conditions.length = 0;
    conditions.push(
      sql`(${gate} = 'open' OR (${gate} = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? ${LEGAL_LISTS_FEATURE_ID})))`,
    );
    const workspaceIds = Object.values(columns).find(
      (column) => column.name === "entity_feature_workspace_ids",
    );
    if (workspaceIds !== undefined) {
      // Equality exposes the overwhelmingly common empty scope to column statistics.
      conditions.push(
        sql`(${workspaceIds} = '{}'::uuid[] OR ${workspaceIds} <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))`,
      );
    }
    const organizationIds = Object.values(columns).find(
      (column) => column.name === "entity_feature_organization_ids",
    );
    if (organizationIds !== undefined) {
      conditions.push(
        sql`(${organizationIds} = '{}'::text[] OR ${organizationIds} <@ ARRAY[(SELECT current_setting('app.organization_id', true))]::text[])`,
      );
    }
  }
  const fence = sql.join(conditions, sql` AND `).inlineParams();
  return [
    pgPolicy("entity_feature_gate_maintenance", {
      for: "all",
      to: ENTITY_FEATURE_GATE_ROLE_NAME,
      using: sql`true`,
      withCheck: sql`true`,
    }),
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
  policyName = "workspace_entity_feature",
): string[] => {
  const dialect = new PgDialect();
  return tables
    .map(getTableConfig)
    .toSorted((left, right) => compareCodeUnit(left.name, right.name))
    .flatMap((config) =>
      config.policies.flatMap((policy) => {
        if (
          policy.name !== policyName ||
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
        AS ${sql.raw(policy.as === "restrictive" ? "RESTRICTIVE" : "PERMISSIVE")} FOR ALL TO ${sql.identifier(policyName === "entity_feature_gate_maintenance" ? ENTITY_FEATURE_GATE_ROLE_NAME : APPLICATION_RLS_ROLE_NAME)}
        USING (${policy.using}) WITH CHECK (${policy.withCheck});
      `.inlineParams(),
            )
            .sql.trim()
            .replace(/\s+/gu, " "),
        ];
      }),
    );
};
