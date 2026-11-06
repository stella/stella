import { panic } from "better-result";
import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import { parseMigrationStatements } from "../../../../scripts/check-migration-safety";
import { flowRuns, flowRunSteps } from "./schema/flows";

const MIGRATION = "20261106091500_flow_run_state_fields";

const declaredChecks = new Map(
  parseMigrationStatements(
    readFileSync(
      new URL(`../../drizzle/${MIGRATION}/migration.sql`, import.meta.url),
      "utf-8",
    ),
  ).flatMap(({ raw }) => {
    const match =
      /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+CHECK\s+\((.*)\)\s+NOT\s+VALID;?$/isu.exec(
        raw.trim(),
      );
    if (match === null) {
      return [];
    }
    return [
      [
        match.at(2) ?? panic("Constraint has no name"),
        {
          tableName: match.at(1) ?? panic("Constraint has no table"),
          condition: match.at(3) ?? panic("Constraint has no condition"),
        },
      ],
    ];
  }),
);

const schemaCheck = (table: PgTable, name: string) => {
  const config = getTableConfig(table);
  const check =
    config.checks.find((candidate) => candidate.name === name) ??
    panic(`Schema declares no ${name}`);
  // Drizzle qualifies columns; a table's own CHECK names them bare.
  return new PgDialect()
    .sqlToQuery(check.value)
    .sql.replaceAll(`"${config.name}".`, "");
};

test("every state-fields check in the schema is the one its migration adds", () => {
  const cases = [
    { table: flowRuns, name: "flow_runs_state_fields_check" },
    { table: flowRunSteps, name: "flow_run_steps_state_fields_check" },
  ];
  expect([...declaredChecks.keys()].toSorted()).toEqual(
    cases.map(({ name }) => name).toSorted(),
  );
  for (const { table, name } of cases) {
    const declared = declaredChecks.get(name) ?? panic(`Missing ${name}`);
    expect(declared.tableName).toBe(getTableConfig(table).name);
    expect(declared.condition).toBe(schemaCheck(table, name));
  }
});
