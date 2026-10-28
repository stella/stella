import { readdir } from "node:fs/promises";

import { compareCodeUnit } from "@stll/collation";

export type EffectiveEntityFeatureGateDefinitions = {
  functions: ReadonlyMap<string, string>;
  policies: ReadonlyMap<string, string>;
  triggers: ReadonlyMap<string, string>;
  indexes: ReadonlyMap<string, string>;
};

const statementKey = (table: string, name: string) => `${table}.${name}`;

/** Fold migrations in application order, so replacements and drops win. */
export const effectiveEntityFeatureGateDefinitions = (
  migrations: readonly string[],
): EffectiveEntityFeatureGateDefinitions => {
  const functions = new Map<string, string>();
  const policies = new Map<string, string>();
  const triggers = new Map<string, string>();
  const indexes = new Map<string, string>();

  for (const migration of migrations) {
    for (const match of migration.matchAll(
      /CREATE OR REPLACE FUNCTION public\.(entity_feature_gate_[a-z_]+)\([^)]*\)[\s\S]*?AS (\$[a-z_]*\$)[\s\S]*?\2;/gu,
    )) {
      functions.set(match[1] ?? "", (match[0] ?? "").trim());
    }
    const policyEvents = [
      ...migration.matchAll(
        /(?<drop>DROP POLICY(?: IF EXISTS)? "?(?<dropName>workspace_entity_feature|entity_feature_gate_maintenance)"? ON (?:"?public"?\.)?"?(?<dropTable>[a-z0-9_]+)"?)|(?<create>CREATE POLICY "?(?<createName>workspace_entity_feature|entity_feature_gate_maintenance)"? ON (?:"?public"?\.)?"?(?<createTable>[a-z0-9_]+)"?[\s\S]*?;)/giu,
      ),
    ].toSorted((left, right) => (left.index ?? 0) - (right.index ?? 0));
    for (const event of policyEvents) {
      const groups = event.groups ?? {};
      if (groups["drop"] !== undefined) {
        policies.delete(
          statementKey(groups["dropTable"] ?? "", groups["dropName"] ?? ""),
        );
      } else {
        policies.set(
          statementKey(groups["createTable"] ?? "", groups["createName"] ?? ""),
          (groups["create"] ?? "").trim(),
        );
      }
    }
    for (const match of migration.matchAll(
      /CREATE TRIGGER (entity_feature_gate_[a-z_]+)[\s\S]*? ON (?:public\.)?"?([a-z0-9_]+)"?[\s\S]*?;/giu,
    )) {
      triggers.set(
        statementKey(match[2] ?? "", match[1] ?? ""),
        (match[0] ?? "").trim(),
      );
    }
    for (const match of migration.matchAll(
      /CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)?(?: IF NOT EXISTS)? "?([a-z0-9_]*entity_feature[a-z0-9_]*)"? ON (?:public\.)?"?([a-z0-9_]+)"?[\s\S]*?;/giu,
    )) {
      indexes.set(
        statementKey(match[2] ?? "", match[1] ?? ""),
        (match[0] ?? "").trim(),
      );
    }
  }
  return { functions, policies, triggers, indexes };
};

export const readEffectiveEntityFeatureGateDefinitions = async (
  drizzleUrl = new URL("../../drizzle/", import.meta.url),
) => {
  const entries = (await readdir(drizzleUrl, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .toSorted(compareCodeUnit);
  const migrations: string[] = [];
  for (const entry of entries) {
    const file = Bun.file(new URL(`${entry}/migration.sql`, drizzleUrl));
    if (await file.exists()) {
      migrations.push(await file.text());
    }
  }
  return effectiveEntityFeatureGateDefinitions(migrations);
};
