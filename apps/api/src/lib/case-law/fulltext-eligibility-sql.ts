// parser-output-unchanged: This predicate selects recovery queue and health rows; it does not construct or change any parser result.
import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { ABSORBED_INTO_METADATA_KEY } from "./decision-absorption";

type DecisionTextEligibilityColumns = {
  redactedAt: SQLWrapper;
  metadata: SQLWrapper;
};

/** Queue and health queries must imply the partial indexes under generic plans. */
export const eligibleDecisionTextSql = (
  t: DecisionTextEligibilityColumns,
): SQL =>
  sql`${t.redactedAt} IS NULL AND ${t.metadata} -> ${sql.raw(`'${ABSORBED_INTO_METADATA_KEY}'`)} IS NULL`;
