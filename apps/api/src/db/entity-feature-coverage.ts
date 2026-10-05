import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
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
  const tableName = getTableName(column.table);
  if (
    column.name === "id" &&
    (tableName === "entities" ||
      tableName === "entity_versions" ||
      tableName === "fields")
  ) {
    relations.add(tableName);
    return relations;
  }
  for (const foreignKey of getTableConfig(column.table).foreignKeys) {
    const reference = foreignKey.reference();
    const index = reference.columns.indexOf(column);
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

/** Schema-derived census: every app-readable entity relation carries its parent's fence. */
export const entityFeatureCoverageViolations = (
  tables: readonly PgTable[],
): string[] => {
  const violations: string[] = [];
  const dialect = new PgDialect();
  for (const table of tables) {
    const config = getTableConfig(table);
    const appReadable = config.policies.some((policy) => {
      const roles = Array.isArray(policy.to) ? policy.to : [policy.to];
      return roles.some(
        (role) =>
          role === "stella" ||
          (typeof role === "object" && role !== null && role.name === "stella"),
      );
    });
    const root = config.columns.find(
      (column) => column.name === "list_item_type",
    );
    const policy = config.policies.find(
      (candidate) => candidate.name === "workspace_entity_feature",
    );
    const required =
      root === undefined
        ? config.columns.flatMap((column) =>
            column.name === "id" &&
            Object.hasOwn(ENTITY_RELATION_ALIASES, config.name)
              ? []
              : [...entityRelationsOf(column)].map((target) => ({
                  column,
                  target,
                })),
          )
        : [{ column: root, target: undefined }];
    const relationships = config.columns.flatMap((column) =>
      column.name === "id" &&
      Object.hasOwn(ENTITY_RELATION_ALIASES, config.name)
        ? []
        : [...entityRelationsOf(column)].map((target) => ({ column, target })),
    );
    for (const { column, target } of relationships) {
      const classification = entityReferenceClassification(column);
      if (classification === undefined || classification.target !== target) {
        violations.push(
          `${config.name}.${column.name} requires a classified entity relationship`,
        );
      }
    }
    if (!appReadable || required.length === 0) {
      continue;
    }
    const expression =
      policy?.using === undefined ? "" : dialect.sqlToQuery(policy.using).sql;
    for (const { column, target } of required) {
      if (target !== undefined) {
        const classification = entityReferenceClassification(column);
        if (
          classification === undefined ||
          classification.target !== target ||
          classification.kind === "context"
        ) {
          continue;
        }
      }
      let alias: string | undefined;
      if (
        target === "entities" ||
        target === "entity_versions" ||
        target === "fields"
      ) {
        alias = ENTITY_RELATION_ALIASES[target];
      }
      if (
        policy?.as !== "restrictive" ||
        policy.for !== "all" ||
        policy.withCheck === undefined ||
        dialect.sqlToQuery(policy.withCheck).sql !== expression ||
        !expression.includes(`"${config.name}"."${column.name}"`) ||
        (target !== undefined &&
          !expression.includes(
            `FROM public.${target} ${alias} WHERE ${alias}.id = "${config.name}"."${column.name}"`,
          ))
      ) {
        violations.push(
          `${config.name}.${column.name} requires the entity feature owner`,
        );
      }
    }
  }
  return violations;
};
