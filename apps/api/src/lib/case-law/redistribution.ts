import { sql } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";

// null descriptor = legacy public-record source, treated as redistributable.
export const redistributableCaseLawSource = sql`(
  ${caseLawSources.descriptor} IS NULL
  OR (${caseLawSources.descriptor} ->> 'allowsRedistribution') = 'true'
)`;

/**
 * The same predicate as raw SQL for sites that join `case_law_sources`
 * under an alias (subqueries where the unaliased Drizzle fragment would
 * collide with an outer join). `alias` must be a code constant.
 */
export const redistributableCaseLawSourceSqlFor = (alias: string): string => `(
  ${alias}.descriptor IS NULL
  OR (${alias}.descriptor ->> 'allowsRedistribution') = 'true'
)`;
