import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import { metadataUrlSchemaForAdapter } from "@/api/handlers/case-law/ingestion/metadata-url-schemas";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ADAPTER_MANIFESTS,
  IMPORT_SOURCE_MANIFESTS,
  STATED_ECLI_IDENTITY,
  type StatedEcliIdentity,
} from "@/api/lib/legal-search/adapter-manifest";
import {
  IMPORT_SOURCE_KEYS,
  type ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";
import { sourceRegistryMembership } from "@/api/lib/legal-search/source-registry-membership";

/** What the pipeline reads off a source's declarations for each decision. */
export type SourceContract = {
  metadataUrlSchema: unknown;
  statedEcliIdentity: StatedEcliIdentity;
};

const isImportSourceKey = (key: string): key is ImportSourceKey =>
  Object.values(IMPORT_SOURCE_KEYS).some((candidate) => candidate === key);

const statedEcliIdentityForAdapter = (
  adapterKey: string,
): StatedEcliIdentity => {
  const membership = sourceRegistryMembership(adapterKey);
  if (membership.type === "registered") {
    return ADAPTER_MANIFESTS[membership.adapterKey].statedEcliIdentity;
  }
  if (isImportSourceKey(adapterKey)) {
    return IMPORT_SOURCE_MANIFESTS[adapterKey].statedEcliIdentity;
  }
  // A seeded source no adapter was written for: nothing vouches for its
  // ECLIs, so an unknown publisher id stays a new decision.
  return STATED_ECLI_IDENTITY.NONE;
};

/** Callers carry the adapter identity; metadata values never select their own contract. */
export const sourceContractForAdapter = (
  adapterKey: string,
): SourceContract => ({
  metadataUrlSchema: metadataUrlSchemaForAdapter(adapterKey),
  statedEcliIdentity: statedEcliIdentityForAdapter(adapterKey),
});

/** Both pipeline entries classify metadata from the persisted source, before any text projection. */
export const readSourceContract = async (
  sourceId: SafeId<"caseLawSource">,
  scopedDb: ScopedDb,
): Promise<SourceContract> => {
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
  return sourceContractForAdapter(source.adapterKey);
};

/** Cache belongs to one pipeline run; persisted source changes are read on the next run. */
export const createSourceContractResolver = (scopedDb: ScopedDb) => {
  const contracts = new Map<SafeId<"caseLawSource">, Promise<SourceContract>>();
  return async (sourceId: SafeId<"caseLawSource">) => {
    const cached = contracts.get(sourceId);
    if (cached !== undefined) {
      return await cached;
    }
    const pending = readSourceContract(sourceId, scopedDb);
    contracts.set(sourceId, pending);
    return await pending;
  };
};

export type SourceContractResolver = ReturnType<
  typeof createSourceContractResolver
>;
