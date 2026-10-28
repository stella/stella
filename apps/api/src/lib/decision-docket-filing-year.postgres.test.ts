import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DECISION_DOCKET_FILING_YEAR_FIXTURES } from "@stll/api-contract/decision-docket-filing-year.fixtures";
import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";

import { executedRows } from "@/api/lib/db/executed-rows";
import {
  decisionDateNotBeforeFilingYearSql,
  decisionDocketFilingYearFunctionSql,
} from "@/api/lib/decision-date-bounds-sql";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

test("the committed SQL function is derived from the registered filing-year rules", () => {
  const migration = readFileSync(
    path.resolve(
      import.meta.dir,
      "../../drizzle/20261028173100_czech_docket_long_sheets/migration.sql",
    ),
    "utf-8",
  );
  expect(
    migration
      .slice(migration.indexOf("CREATE OR REPLACE FUNCTION"))
      .trim()
      .replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION"),
  ).toBe(decisionDocketFilingYearFunctionSql());
});

describe.skipIf(!enabled)("docket filing-year parity (postgres)", () => {
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

test("the generated filing-year function agrees with the grammar on Czech long sheets", async () => {
  await using db = await PGlite.create();
  await db.exec(decisionDocketFilingYearFunctionSql());
  const fixtures = DECISION_DOCKET_FILING_YEAR_FIXTURES.filter(
    ({ jurisdiction }) => jurisdiction === "CZE",
  );
  const results = await db.query<{ result: unknown }>(
    `
    SELECT public.decision_docket_filing_year("caseNumber", jurisdiction) AS result
    FROM jsonb_to_recordset($1::text::jsonb) AS input("caseNumber" text, jurisdiction text)
  `,
    [JSON.stringify(fixtures)],
  );
  expect(results.rows.map(({ result }) => result)).toEqual(
    fixtures.map(({ caseNumber, expected }) => {
      const parsed = DECISION_DOCKET_GRAMMARS.CZE.filingYear(caseNumber);
      expect(parsed).toEqual(expected);
      return parsed;
    }),
  );
});
