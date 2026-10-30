import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawListingObservations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { insertInChunks } from "@/api/lib/db/bulk-write";
import type { ListingObservation } from "@/api/lib/legal-search/quarantine-identity";

type StoreListingObservationsOptions = {
  sourceId: SafeId<"caseLawSource">;
  adapterKey: string;
  observations: readonly ListingObservation[];
};

/** Store evidence before progress, independently of every canonical decision path. */
export const storeListingObservations = async (
  scopedDb: ScopedDb,
  { sourceId, adapterKey, observations }: StoreListingObservationsOptions,
): Promise<void> => {
  const rows = observations.map((observation) => {
    if (observation.identity.source !== adapterKey) {
      panic("Listing observation belongs to a different source adapter");
    }
    return {
      sourceId,
      fingerprint: observation.identity.fingerprint,
      adapterKey,
      reason: observation.reason,
      payload: { listing: observation.payload },
    };
  });
  await insertInChunks(
    rows,
    async (batch) =>
      await scopedDb(async (tx) => {
        // audit: skip — background public-corpus observations, not user actions; provenance remains in the immutable ledger and ingestion run records
        await tx
          .insert(caseLawListingObservations)
          .values(batch)
          .onConflictDoNothing({
            target: [
              caseLawListingObservations.sourceId,
              caseLawListingObservations.fingerprint,
            ],
          });
      }),
  );
};
