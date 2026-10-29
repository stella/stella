import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { DECISION_DOCKET_FILING_YEAR_FIXTURES } from "@stll/api-contract/decision-docket-filing-year.fixtures";

import { readDecisionDocketFilingYearMigration } from "@/api/tests/decision-docket-filing-year-migration";

test("the committed filing-year function agrees with every shared format in PostgreSQL", async () => {
  await using db = await PGlite.create();
  await db.exec(readDecisionDocketFilingYearMigration());
  const result = await db.query(
    `
    SELECT ordinal::integer AS position,
      public.decision_docket_filing_year(case_number, country) AS result
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS v(case_number, country, ordinal)
    ORDER BY ordinal
  `,
    [
      DECISION_DOCKET_FILING_YEAR_FIXTURES.map(({ caseNumber }) => caseNumber),
      DECISION_DOCKET_FILING_YEAR_FIXTURES.map(
        ({ jurisdiction }) => jurisdiction,
      ),
    ],
  );
  expect(result.rows).toEqual(
    DECISION_DOCKET_FILING_YEAR_FIXTURES.map(({ expected }, position) => ({
      position: position + 1,
      result: expected,
    })),
  );
});
