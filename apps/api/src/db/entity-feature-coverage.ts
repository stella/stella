import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

const ENTITY_RELATION_ALIASES = {
  entities: "e",
  entity_versions: "v",
  fields: "f",
} as const;
const ENTITY_RELATIONS = new Set(Object.keys(ENTITY_RELATION_ALIASES));

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
    if (!appReadable) {
      continue;
    }
    const root = config.columns.find(
      (column) => column.name === "list_item_type",
    );
    const policy = config.policies.find(
      (candidate) => candidate.name === "workspace_entity_feature",
    );
    const required =
      root === undefined
        ? config.foreignKeys.flatMap((foreignKey) => {
            const reference = foreignKey.reference();
            return ENTITY_RELATIONS.has(getTableName(reference.foreignTable))
              ? reference.columns.flatMap((column, index) =>
                  reference.foreignColumns[index]?.name === "id"
                    ? [{ column, target: getTableName(reference.foreignTable) }]
                    : [],
                )
              : [];
          })
        : [{ column: root, target: undefined }];
    if (required.length === 0) {
      continue;
    }
    const expression =
      policy?.using === undefined ? "" : dialect.sqlToQuery(policy.using).sql;
    for (const { column, target } of required) {
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
