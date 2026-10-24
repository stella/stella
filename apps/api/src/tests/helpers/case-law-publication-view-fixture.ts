import { sql } from "drizzle-orm";

import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions-sql";

/** Install the canonical view against whichever case-law table is first on search_path. */
export const caseLawPublishedDecisionsFixtureSql = sql.raw(
  `CREATE TEMP VIEW case_law_published_decisions AS
    SELECT decision.* FROM case_law_decisions decision
    WHERE ${publishedCaseLawDecisionSqlFor("decision")}`,
);

/** Public-subject locators may inspect an unredacted candidate before gating it. */
export const caseLawUnredactedDecisionsFixtureSql = sql.raw(
  `CREATE TEMP VIEW case_law_unredacted_decisions AS
    SELECT * FROM case_law_decisions WHERE redacted_at IS NULL`,
);
