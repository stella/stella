import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

/**
 * Whether a source's text may be fed to a model. A separate permission from
 * redistribution: a source may allow showing its wording but not AI use.
 * null descriptor = legacy public-record source, as for redistribution.
 *
 * Kept apart from `redistribution-sql.ts`, which parsers import: an AI read
 * gate is not parse logic and must not change any parser's inputs.
 */
export const derivedAiCaseLawSourceFor = (descriptor: SQLWrapper) => sql`(
  ${descriptor} IS NULL
  OR (${descriptor} ->> 'allowsDerivedAi') = 'true'
)`;
