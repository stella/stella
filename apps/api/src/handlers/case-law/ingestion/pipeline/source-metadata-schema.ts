import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import { metadataUrlSchemaForAdapter } from "@/api/handlers/case-law/ingestion/metadata-url-schemas";
import type { SafeId } from "@/api/lib/branded-types";

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

/** Cache belongs to one pipeline run; persisted source changes are read on the next run. */
export const createSourceMetadataUrlSchemaResolver = (scopedDb: ScopedDb) => {
  const schemas = new Map<
    SafeId<"caseLawSource">,
    ReturnType<typeof resolveSourceMetadataUrlSchema>
  >();
  return async (sourceId: SafeId<"caseLawSource">) => {
    const cached = schemas.get(sourceId);
    if (cached !== undefined) {
      return await cached;
    }
    const pending = resolveSourceMetadataUrlSchema(sourceId, scopedDb);
    schemas.set(sourceId, pending);
    return await pending;
  };
};

export type SourceMetadataUrlSchemaResolver = ReturnType<
  typeof createSourceMetadataUrlSchemaResolver
>;
