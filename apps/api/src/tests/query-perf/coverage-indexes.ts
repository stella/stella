import { panic } from "better-result";

import { CASE_LAW_COVERAGE_INDEXES } from "@/api/lib/case-law/coverage-index";

const ONLINE_BUILD = "CREATE INDEX CONCURRENTLY";

/**
 * The online coverage indexes as a fixture installs them: production's own
 * declarations, built in place on the corresponding table in `schemaName`,
 * and skipped where the migrated template already holds them.
 */
export const coverageIndexBuildSql = (schemaName: string) =>
  CASE_LAW_COVERAGE_INDEXES.map(({ createSql, name, tableName }) => {
    const publicTable = `public."${tableName}"`;
    return createSql.startsWith(ONLINE_BUILD) && createSql.includes(publicTable)
      ? createSql
          .replace(ONLINE_BUILD, "CREATE INDEX IF NOT EXISTS")
          .replace(publicTable, () => `"${schemaName}"."${tableName}"`)
      : panic(`${name} is not an online build on public.${tableName}`);
  });
