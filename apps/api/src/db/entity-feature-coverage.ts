import { getColumnTable, getTableName, is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgRole } from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTable, PgPolicyConfig } from "drizzle-orm/pg-core";

import { entityReferenceClassification } from "./entity-feature-policies";

const targetsApplicationRole = (to: PgPolicyConfig["to"]): boolean => {
  if (Array.isArray(to)) {
    return to.some(targetsApplicationRole);
  }
  return to === "stella" || (is(to, PgRole) && to.name === "stella");
};

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

const ENTITY_FEATURE_POLICY_NAME = "workspace_entity_feature";

const carriesEntityFeatureFence = (table: PgTable) =>
  getTableConfig(table).policies.some(
    (policy) => policy.name === ENTITY_FEATURE_POLICY_NAME,
  );

type ParentRequirement = {
  /** Undefined when the foreign key does not carry the parent's identity. */
  column: AnyPgColumn | undefined;
  parent: PgTable;
  parentName: string;
};

/** Records that hang off a fenced non-entity row must be hidden with that row. */
const fencedParentRequirements = (table: PgTable): ParentRequirement[] => {
  const requirements = new Map<string, ParentRequirement>();
  for (const foreignKey of getTableConfig(table).foreignKeys) {
    const reference = foreignKey.reference();
    const parent = reference.foreignTable;
    const parentName = getTableName(parent);
    if (
      Object.hasOwn(ENTITY_RELATION_ALIASES, parentName) ||
      !carriesEntityFeatureFence(parent)
    ) {
      continue;
    }
    const identity = reference.foreignColumns.findIndex(
      (target) => target.name === "id",
    );
    const column = identity === -1 ? undefined : reference.columns.at(identity);
    // Keys that project an entity identifier are already held to the entity rule.
    if (
      (column === undefined ? reference.columns : [column]).some(
        (source) => entityRelationsOf(source).size > 0,
      )
    ) {
      continue;
    }
    requirements.set(`${parentName}.${column?.name ?? ""}`, {
      column,
      parent,
      parentName,
    });
  }
  return [...requirements.values()];
};

/** Schema-derived census: every app-readable entity relation carries its parent's fence. */
export const entityFeatureCoverageViolations = (
  tables: readonly PgTable[],
): string[] => {
  const violations: string[] = [];
  const dialect = new PgDialect();
  for (const table of tables) {
    const config = getTableConfig(table);
    const appReadable = config.policies.some((policy) =>
      targetsApplicationRole(policy.to),
    );
    const root = config.columns.find(
      (column) => column.name === "list_item_type",
    );
    const policy = config.policies.find(
      (candidate) => candidate.name === ENTITY_FEATURE_POLICY_NAME,
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
    const parents = appReadable ? fencedParentRequirements(table) : [];
    if (!appReadable || (required.length === 0 && parents.length === 0)) {
      continue;
    }
    const expression =
      policy?.using === undefined ? "" : dialect.sqlToQuery(policy.using).sql;
    const fenced = (column: AnyPgColumn, relationExpression?: string) =>
      policy?.as === "restrictive" &&
      policy.for === "all" &&
      policy.withCheck !== undefined &&
      dialect.sqlToQuery(policy.withCheck).sql === expression &&
      expression.includes(`"${config.name}"."${column.name}"`) &&
      (relationExpression === undefined ||
        expression.includes(relationExpression));
    for (const { column, target } of required) {
      if (target !== undefined) {
        const classification = entityReferenceClassification(column);
        if (
          classification?.kind !== "owned-content" ||
          classification.target !== target
        ) {
          continue;
        }
      }
      const relationExpression =
        target === undefined
          ? undefined
          : `FROM public.${target} ${ENTITY_RELATION_ALIASES[target]} WHERE ${ENTITY_RELATION_ALIASES[target]}.id = "${config.name}"."${column.name}"`;
      if (!fenced(column, relationExpression)) {
        violations.push(
          `${config.name}.${column.name} requires the entity feature owner`,
        );
      }
    }
    for (const { column, parent, parentName } of parents) {
      if (column === undefined) {
        violations.push(
          `${config.name} references ${parentName} without its identity`,
        );
        continue;
      }
      const classification = entityReferenceClassification(column);
      if (
        classification?.kind !== "owned-by-parent" ||
        classification.parent !== parent
      ) {
        violations.push(
          `${config.name}.${column.name} requires a classified parent relationship`,
        );
        continue;
      }
      const schemaName = getTableConfig(parent).schema ?? "public";
      if (
        !fenced(
          column,
          `FROM "${schemaName}"."${parentName}" parent_row WHERE parent_row.id = "${config.name}"."${column.name}"`,
        )
      ) {
        violations.push(
          `${config.name}.${column.name} requires the parent feature fence`,
        );
      }
    }
  }
  return violations;
};
