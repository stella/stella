import { panic } from "better-result";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import { parseMigrationStatements } from "../../../../../scripts/check-migration-safety";

type AddedCheck = { tableName: string; condition: string };

/** The CHECK constraints a migration adds NOT VALID, by constraint name. */
export const notValidChecksOf = (migration: string): Map<string, AddedCheck> =>
  new Map(
    parseMigrationStatements(
      readFileSync(
        new URL(`../../../drizzle/${migration}/migration.sql`, import.meta.url),
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

/** A schema CHECK rendered as its migration writes it, with bare column names. */
export const schemaCheckCondition = (table: PgTable, name: string): string => {
  const config = getTableConfig(table);
  const check =
    config.checks.find((candidate) => candidate.name === name) ??
    panic(`Schema declares no ${name}`);
  return new PgDialect()
    .sqlToQuery(check.value)
    .sql.replaceAll(`"${config.name}".`, "");
};
