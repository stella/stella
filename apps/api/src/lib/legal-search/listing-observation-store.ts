import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawListingObservations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { ListingObservation } from "@/api/lib/legal-search/quarantine-identity";

const MAX_OBSERVATIONS_PER_WRITE = 100;
const MAX_OBSERVATION_WRITE_BYTES = 512 * 1024;

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
  let rows: (typeof caseLawListingObservations.$inferInsert)[] = [];
  let bytes = 0;
  const flush = async () => {
    if (rows.length === 0) {
      return;
    }
    const batch = rows;
    rows = [];
    bytes = 0;
    await scopedDb(async (tx) => {
      // audit: skip — immutable evidence of public publisher listings
      await tx
        .insert(caseLawListingObservations)
        .values(batch)
        .onConflictDoNothing({
          target: [
            caseLawListingObservations.sourceId,
            caseLawListingObservations.fingerprint,
          ],
        });
    });
  };
  for (const observation of observations) {
    if (observation.identity.source !== adapterKey) {
      panic("Listing observation belongs to a different source adapter");
    }
    const payload = { listing: observation.payload };
    const size = Buffer.byteLength(JSON.stringify(payload));
    if (
      rows.length > 0 &&
      (rows.length >= MAX_OBSERVATIONS_PER_WRITE ||
        bytes + size > MAX_OBSERVATION_WRITE_BYTES)
    ) {
      // db-await-in-loop: bounded evidence batches settle before source progress
      await flush();
    }
    rows.push({
      sourceId,
      fingerprint: observation.identity.fingerprint,
      adapterKey,
      reason: observation.reason,
      payload,
    });
    bytes += size;
  }
  await flush();
};
