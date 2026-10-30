import { panic } from "better-result";

import { CASE_LAW_COVERAGE_INDEXES } from "@/api/lib/case-law/coverage-index";

const ONLINE_BUILD = "CREATE INDEX CONCURRENTLY";
const PUBLIC_DECISIONS = 'public."case_law_decisions"';

/**
 * The online coverage indexes as a fixture installs them: production's own
 * declarations, built in place on the decisions table in `schemaName`, and
 * skipped where the migrated template already holds them.
 */
export const coverageIndexBuildSql = (schemaName: string) =>
  CASE_LAW_COVERAGE_INDEXES.map(({ createSql, name }) =>
    createSql.startsWith(ONLINE_BUILD) && createSql.includes(PUBLIC_DECISIONS)
      ? createSql
          .replace(ONLINE_BUILD, "CREATE INDEX IF NOT EXISTS")
          .replace(
            PUBLIC_DECISIONS,
            () => `"${schemaName}"."case_law_decisions"`,
          )
      : panic(`${name} is not an online build on public.case_law_decisions`),
  );
