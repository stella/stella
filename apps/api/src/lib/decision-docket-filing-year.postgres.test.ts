import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import fc from "fast-check";
import { readFileSync } from "node:fs";

import { DECISION_DOCKET_FILING_YEAR_FIXTURES } from "@stll/api-contract/decision-docket-filing-year.fixtures";
import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import { docketReaderEntryArbitrary } from "@stll/api-contract/decision-docket-identity.fixtures";
import { assertProperty } from "@stll/property-testing";

import { executedRows } from "@/api/lib/db/executed-rows";
import {
  decisionDateNotBeforeFilingYearSql,
  decisionDocketFilingYearFunctionSql,
} from "@/api/lib/decision-date-bounds-sql";
import { isRecord } from "@/api/lib/type-guards";
import { readDecisionDocketFilingYearMigration } from "@/api/tests/decision-docket-filing-year-migration";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

test("the committed SQL function is derived from the registered filing-year rules", () => {
  const migration = readDecisionDocketFilingYearMigration();
  const declaration = migration.startsWith("CREATE OR REPLACE")
    ? "replace"
    : "create";
  expect(migration).toBe(decisionDocketFilingYearFunctionSql(declaration));
});

describe.skipIf(!enabled)("docket filing-year parity (postgres)", () => {
  test("filing-year.replacement-preserves-unprefixed-dockets", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Filing-year parity requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const prior = readFileSync(
        new URL(
          "../../drizzle/20261027160700_decision_docket_filing_year/migration.sql",
          import.meta.url,
        ),
        "utf-8",
      );
      const declaration = prior.indexOf(
        "CREATE FUNCTION public.decision_docket_filing_year(",
      );
      const end = prior.indexOf("$function$;", declaration);
      if (declaration === -1 || end === -1) {
        return panic(
          "The original filing-year function must remain in migration history",
        );
      }
      await db.execute(
        sql.raw(
          prior
            .slice(declaration, end + "$function$;".length)
            .replace(
              "public.decision_docket_filing_year(",
              "pg_temp.filing_year_before_replacement(",
            ),
        ),
      );
      const prefix = executedRows(
        await db.execute(sql`
        SELECT public.decision_docket_filing_year('B4-7Co/91/2022', 'SVK') AS current,
          pg_temp.filing_year_before_replacement('B4-7Co/91/2022', 'SVK') AS previous
      `),
      );
      expect(prefix).toEqual([
        {
          current: { type: "known", year: 2022 },
          previous: { type: "unparseable" },
        },
      ]);
      const fixtures = executedRows(
        await db.execute(sql`
        SELECT v.position,
          public.decision_docket_filing_year(v.case_number, v.country) AS current,
          pg_temp.filing_year_before_replacement(v.case_number, v.country) AS previous
        FROM (VALUES ${sql.join(
          DECISION_DOCKET_FILING_YEAR_FIXTURES.map(
            ({ jurisdiction, caseNumber }, position) =>
              sql`(${position}::integer, ${caseNumber}::text, ${jurisdiction}::text)`,
          ),
          sql`, `,
        )}) AS v(position, case_number, country)
        ORDER BY v.position
      `),
      );
      expect(fixtures).toEqual(
        DECISION_DOCKET_FILING_YEAR_FIXTURES.map(({ expected }, position) => ({
          position,
          current: expected,
          previous: expected,
        })),
      );
      await assertProperty(
        "filing-year.replacement-preserves-unprefixed-dockets",
        fc.asyncProperty(
          docketReaderEntryArbitrary,
          async ({ jurisdiction, filed, entry }) => {
            const rows = executedRows(
              await db.execute(sql`
          SELECT public.decision_docket_filing_year(v.case_number, ${jurisdiction}) AS current,
            pg_temp.filing_year_before_replacement(v.case_number, ${jurisdiction}) AS previous
          FROM (VALUES (${filed}::text), (${entry}::text)) AS v(case_number)
        `),
            );
            expect(rows).toHaveLength(2);
            for (const row of rows) {
              if (!isRecord(row)) {
                return panic("Filing-year parity requires a database row");
              }
              expect(row["current"]).toEqual(row["previous"]);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  test("the migrated function agrees with the TypeScript owner on the shared corpus", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Filing-year parity requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const rows = executedRows(
        await db.execute(sql`
        SELECT v.position, public.decision_docket_filing_year(v.case_number, v.country) AS result
        FROM (VALUES ${sql.join(
          DECISION_DOCKET_FILING_YEAR_FIXTURES.map(
            ({ jurisdiction, caseNumber }, position) =>
              sql`(${position}::integer, ${caseNumber}::text, ${jurisdiction}::text)`,
          ),
          sql`, `,
        )}) AS v(position, case_number, country)
        ORDER BY v.position
      `),
      );
      expect(rows).toEqual(
        DECISION_DOCKET_FILING_YEAR_FIXTURES.map(
          ({ jurisdiction, caseNumber, expected }, position) => {
            const result =
              DECISION_DOCKET_GRAMMARS[jurisdiction].filingYear(caseNumber);
            expect(result, `${jurisdiction}: ${caseNumber}`).toEqual(expected);
            return { position, result };
          },
        ),
      );
      const verdicts = executedRows(
        await db.execute(sql`
        SELECT v.case_number, ${decisionDateNotBeforeFilingYearSql({
          date: sql`v.date`,
          country: sql`v.country`,
          caseNumber: sql`v.case_number`,
        })} AS plausible
        FROM (VALUES
          ('7 Co 91/2022', 'CZE', '1872-10-28'::date),
          ('23 C 57/2020', 'CZE', '1898-10-28'::date),
          ('6 As 83/2019', 'CZE', '2019-01-01'::date),
          ('7Co/91/2022', 'SVK', '2021-12-31'::date),
          ('No. 42', 'USA', '1900-01-01'::date),
          ('unparsed', 'CZE', '1900-01-01'::date),
          ('6 As 83/2019', 'CZE', NULL::date)
        ) AS v(case_number, country, date)
      `),
      );
      expect(verdicts).toEqual([
        { case_number: "7 Co 91/2022", plausible: false },
        { case_number: "23 C 57/2020", plausible: false },
        { case_number: "6 As 83/2019", plausible: true },
        { case_number: "7Co/91/2022", plausible: false },
        { case_number: "No. 42", plausible: true },
        { case_number: "unparsed", plausible: true },
        { case_number: "6 As 83/2019", plausible: true },
      ]);
    });
  });
});
