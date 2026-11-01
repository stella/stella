import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { PgPolicy, PgTable } from "drizzle-orm/pg-core";

import { compareCodeUnit } from "@stll/collation";

import type { PolicyDefinition } from "./online-ddl";
import { ORG_SCOPE_ROLE_NAMES } from "./org-scope-role-names";
import { LINKED_POLICIES, tablePolicies } from "./table-policies";

const OWNER_ROLES: ReadonlySet<string> = new Set(
  Object.values(ORG_SCOPE_ROLE_NAMES),
);

/** Every declared owner policy is installed; names never form an exclusion list. */
export const scopedOwnerPolicyDefinitions = (
  tables: readonly PgTable[],
  linked: readonly PgPolicy[] = LINKED_POLICIES,
): PolicyDefinition[] => {
  const dialect = new PgDialect();
  const render = (expression: SQL) =>
    dialect.sqlToQuery(expression.inlineParams()).sql;
  return tables
    .map((table) => ({ config: getTableConfig(table), table }))
    .toSorted((a, b) => compareCodeUnit(a.config.name, b.config.name))
    .flatMap(({ config, table }) =>
      tablePolicies(table, linked)
        .toSorted((a, b) => compareCodeUnit(a.name, b.name))
        .flatMap((policy): PolicyDefinition[] => {
          const targets = Array.isArray(policy.to) ? policy.to : [policy.to];
          const roles = targets.flatMap((role) => {
            if (typeof role === "string") {
              return [role];
            }
            if (role === undefined) {
              return [];
            }
            if ("name" in role) {
              return [role.name];
            }
            return panic("Owner policy roles must be a flat list");
          });
          const role = roles.find((name) => OWNER_ROLES.has(name));
          if (role === undefined) {
            return [];
          }
          if (
            (config.schema ?? "public") !== "public" ||
            roles.length !== 1 ||
            policy.using === undefined
          ) {
            return panic(
              `Owner policy ${config.name}.${policy.name} requires one role and its row predicate`,
            );
          }
          return [
            {
              tableName: config.name,
              name: policy.name,
              as: policy.as ?? "permissive",
              for: policy.for ?? "all",
              role,
              using: render(policy.using),
              ...(policy.withCheck === undefined
                ? {}
                : { withCheck: render(policy.withCheck) }),
            },
          ];
        }),
    );
};
