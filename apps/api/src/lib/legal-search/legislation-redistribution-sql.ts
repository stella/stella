import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

/**
 * Whether a legislation source's descriptor allows redistribution; a null
 * descriptor is a legacy public source. Schema-free so row policies in
 * `db/schema` can use it without importing the schema back.
 */
export const redistributableLegislationSourceFor = (
  descriptor: SQLWrapper,
) => sql`(
  ${descriptor} IS NULL
  OR (${descriptor} ->> 'allowsRedistribution') = 'true'
)`;
