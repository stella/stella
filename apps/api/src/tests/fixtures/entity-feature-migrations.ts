import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";

import { readCommittedMigrations } from "@/api/tests/stella-table-privileges";

const INITIAL_GATE_MIGRATION = "20261009112500_entity_feature_row_gates";

export const readEntityFeatureMigrations = () =>
  readCommittedMigrations()
    .filter(({ name }) => name >= INITIAL_GATE_MIGRATION)
    .map(({ sql }) => sql)
    .join("\n");

export const latestEntityFeaturePolicies = (
  migration: string,
  name: string,
) => {
  const statements = migration.matchAll(
    new RegExp(`CREATE POLICY "${name}"[^;]+;`, "gu"),
  );
  const byTable = new Map<string, string>();
  for (const [statement] of statements) {
    const table = /ON "public"\."([^"]+)"/u.exec(statement)?.at(1);
    if (table === undefined) {
      panic("Entity feature policy has no public table");
    }
    byTable.set(table, statement.replace(/\s+/gu, " ").trim());
  }
  return [...byTable.entries()]
    .toSorted(([left], [right]) => compareCodeUnit(left, right))
    .map(([, statement]) => statement);
};
