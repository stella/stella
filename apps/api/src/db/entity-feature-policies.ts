import { panic } from "better-result";
import { getColumnTable, sql } from "drizzle-orm";
import type { GetColumnData, SQLWrapper } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTable, PgPolicy } from "drizzle-orm/pg-core";

import type { EntityContextReference } from "@stll/api-contract/entity-reference";

export type EntityReferenceClassification =
  | {
      target: "entities" | "entity_versions" | "fields";
      kind: "owned-content" | "context";
    }
  | {
      /** A dependent record owned by its parent row. */
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

/** Retains relationship metadata for context projections without adding feature policies. */
export const entityFeaturePolicies = (
  _columns: Record<string, AnyPgColumn>,
  references: ReadonlyMap<
    AnyPgColumn,
    EntityReferenceClassification
  > = new Map(),
): PgPolicy[] => {
  for (const [column, classification] of references) {
    let tableReferences = entityReferences.get(getColumnTable<PgTable>(column));
    if (tableReferences === undefined) {
      tableReferences = new Map();
      entityReferences.set(getColumnTable<PgTable>(column), tableReferences);
    }
    tableReferences.set(column.name, classification);
  }
  return [];
};
