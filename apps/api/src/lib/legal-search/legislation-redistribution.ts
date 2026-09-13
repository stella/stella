import { sql } from "drizzle-orm";

import { legislationSources } from "@/api/db/schema";

// null descriptor = legacy public source, treated as redistributable.
export const redistributableLegislationSource = sql`(
  ${legislationSources.descriptor} IS NULL
  OR (${legislationSources.descriptor} ->> 'allowsRedistribution') = 'true'
)`;
