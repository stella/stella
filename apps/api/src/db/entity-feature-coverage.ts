import { getColumnTable, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { entityReferenceClassification } from "./entity-feature-policies";

const ENTITY_RELATION_ALIASES = {
  entities: "e",
  entity_versions: "v",
  fields: "f",
} as const;
type EntityRelation = keyof typeof ENTITY_RELATION_ALIASES;

/** FK-equivalent identifiers retain their resource identity across projections. */
const entityRelationsOf = (
  column: AnyPgColumn,
  visited = new Set<AnyPgColumn>(),
): Set<EntityRelation> => {
  const relations = new Set<EntityRelation>();
  if (visited.has(column)) {
    return relations;
  }
  visited.add(column);
  const tableName = getTableName(getColumnTable<PgTable>(column));
  if (
    column.name === "id" &&
    (tableName === "entities" ||
      tableName === "entity_versions" ||
      tableName === "fields")
  ) {
    relations.add(tableName);
    return relations;
  }
  for (const foreignKey of getTableConfig(getColumnTable<PgTable>(column))
    .foreignKeys) {
    const reference = foreignKey.reference();
    const index = reference.columns.findIndex(
      (source) => source.name === column.name,
    );
    if (index === -1) {
      continue;
    }
    const parent = reference.foreignColumns.at(index);
    if (parent === undefined) {
      continue;
    }
    for (const relation of entityRelationsOf(parent, visited)) {
      relations.add(relation);
    }
  }
  return relations;
};

/** Schema-derived census of entity relationships used by context projections. */
export const entityFeatureCoverageViolations = (
  tables: readonly PgTable[],
): string[] => {
  const violations: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const relationships = config.columns.flatMap((column) =>
      column.name === "id" &&
      Object.hasOwn(ENTITY_RELATION_ALIASES, config.name)
        ? []
        : [...entityRelationsOf(column)].map((target) => ({ column, target })),
    );
    for (const { column, target } of relationships) {
      const classification = entityReferenceClassification(column);
      if (
        classification === undefined ||
        classification.kind === "owned-by-parent" ||
        classification.target !== target
      ) {
        violations.push(
          `${config.name}.${column.name} requires a classified entity relationship`,
        );
      }
    }
  }
  return violations;
};
