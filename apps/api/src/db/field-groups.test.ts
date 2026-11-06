import { panic } from "better-result";
import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import { parseMigrationStatements } from "../../../../scripts/check-migration-safety";
import { schedulerJobs } from "./schema/contacts";

const MIGRATION = "20261106103000_scheduler_job_lease_fields";
const CHECK = "scheduler_jobs_lease_fields_check";

test("the scheduler lease check in the schema is the one its migration adds", () => {
  const [statement, ...others] = parseMigrationStatements(
    readFileSync(
      new URL(`../../drizzle/${MIGRATION}/migration.sql`, import.meta.url),
      "utf-8",
    ),
  ).flatMap(({ raw }) => {
    const match =
      /^ALTER\s+TABLE\s+"scheduler_jobs"\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+CHECK\s+\((.*)\)\s+NOT\s+VALID;?$/isu.exec(
        raw.trim(),
      );
    return match === null ? [] : [match];
  });
  expect(others).toEqual([]);
  expect(statement?.at(1)).toBe(CHECK);
  const config = getTableConfig(schedulerJobs);
  const check =
    config.checks.find(({ name }) => name === CHECK) ??
    panic(`Schema declares no ${CHECK}`);
  // Drizzle qualifies columns; a table's own CHECK names them bare.
  expect(statement?.at(2)).toBe(
    new PgDialect()
      .sqlToQuery(check.value)
      .sql.replaceAll(`"${config.name}".`, ""),
  );
});
