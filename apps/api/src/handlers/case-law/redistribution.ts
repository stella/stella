import { sql } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";

// null descriptor = legacy public-record source, treated as redistributable.
export const redistributableCaseLawSource = sql`(
  ${caseLawSources.descriptor} IS NULL
  OR (${caseLawSources.descriptor} ->> 'allowsRedistribution') = 'true'
)`;
