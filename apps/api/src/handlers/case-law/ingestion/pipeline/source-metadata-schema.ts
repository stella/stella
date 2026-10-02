import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { metadataUrlSchemaForAdapter } from "@/api/lib/legal-search/metadata-url-schemas";

/** Both pipeline entries classify metadata from the persisted source, before any text projection. */
export const resolveSourceMetadataUrlSchema = async (
  sourceId: SafeId<"caseLawSource">,
  scopedDb: ScopedDb,
) => {
  const source = (
    await scopedDb(
      async (tx) =>
        await tx
          .select({ adapterKey: caseLawSources.adapterKey })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
          .limit(1),
    )
  ).at(0);
  if (source === undefined) {
    return panic(
      `Cannot classify ingestion metadata: source ${sourceId} is absent`,
    );
  }
  return metadataUrlSchemaForAdapter(source.adapterKey);
};
