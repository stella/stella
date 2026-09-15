import { sql } from "drizzle-orm";

import { legislationDocuments, legislationSources } from "@/api/db/schema";

// null descriptor = legacy public source, treated as redistributable.
export const redistributableLegislationSource = sql`(
  ${legislationSources.descriptor} IS NULL
  OR (${legislationSources.descriptor} ->> 'allowsRedistribution') = 'true'
)`;

/**
 * The same policy, correlated to `legislation_documents`, for a read that
 * addresses a version by id instead of joining its source. A public read of a
 * version applies one of the two forms; neither carries a policy of its own.
 */
export const redistributableLegislationVersion = sql`EXISTS (
  SELECT 1
    FROM ${legislationSources}
   WHERE ${legislationSources.id} = ${legislationDocuments.sourceId}
     AND ${redistributableLegislationSource}
)`;

/** AI use is a separate permission from displaying source wording. */
export const derivedAiLegislationVersion = sql`EXISTS (
  SELECT 1 FROM ${legislationSources}
   WHERE ${legislationSources.id} = ${legislationDocuments.sourceId}
     AND (${legislationSources.descriptor} IS NULL
          OR (${legislationSources.descriptor} ->> 'allowsDerivedAi') = 'true')
)`;
