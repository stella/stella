import { sql, type SQLWrapper } from "drizzle-orm";

// null descriptor = legacy public-record source, treated as redistributable.
export const redistributableCaseLawSourceFor = (descriptor: SQLWrapper) => sql`(
  ${descriptor} IS NULL
  OR (${descriptor} ->> 'allowsRedistribution') = 'true'
)`;

/**
 * The same predicate as raw SQL for sites that join `case_law_sources`
 * under an alias. `alias` must be a code constant.
 */
export const redistributableCaseLawSourceSqlFor = (alias: string): string => `(
  ${alias}.descriptor IS NULL
  OR (${alias}.descriptor ->> 'allowsRedistribution') = 'true'
)`;
