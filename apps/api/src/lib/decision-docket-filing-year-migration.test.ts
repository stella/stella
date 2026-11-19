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

/** PostgreSQL keeps this many compiled regexes per backend (`MAX_CACHED_RES`). */
const POSTGRES_COMPILED_REGEX_CACHE = 32;

test("the committed filing-year function runs each pattern once and fits the regex cache", () => {
  const migration = readDecisionDocketFilingYearMigration();
  const literal = String.raw`'((?:[^']|'')*)'`;
  const patterns = [
    ...migration.matchAll(
      new RegExp(
        String.raw`(?:regexp_match\(folded, |substring\(folded FROM |folded ~\*? )${literal}`,
        "gu",
      ),
    ),
  ].map(([, pattern]) => pattern);
  expect(patterns.length).toBeGreaterThan(0);
  // A pattern read again for its capture re-runs the match on every row.
  expect(new Set(patterns).size).toBe(patterns.length);
  // The fold is bound to a variable once instead of inlined into each match.
  const folds = [...migration.matchAll(/folded := /gu)].length;
  expect(folds).toBe(
    [...migration.matchAll(/normalize\(coalesce\(case_number/gu)].length,
  );
  const regexes = new Set([
    ...patterns,
    // regexp_replace(source, pattern, replacement[, flags]) in the fold.
    ...[
      ...migration.matchAll(
        new RegExp(
          String.raw`,\s*(?:U&)?${literal}, '[^']*'(?:, 'g')?\)`,
          "gu",
        ),
      ),
    ].map(([, pattern]) => pattern),
  ]);
  // Past the cache, every row recompiles the patterns it evaluates.
  expect(regexes.size).toBeLessThan(POSTGRES_COMPILED_REGEX_CACHE);
});
