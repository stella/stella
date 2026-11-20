/** The per-version MinHash signature written by native extraction. */

import type { Transaction } from "@/api/db/root";
import {
  entityVersionMinhashBands,
  entityVersionMinhashSignatures,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { contentLookupKey } from "@/api/lib/content-encryption";
import {
  lshBandKeys,
  minHashSeeds,
  minHashSignature,
  signatureToBytes,
} from "@/api/lib/uploads/near-duplicates/minhash";

const SEED_LOOKUP_VALUE = "near-duplicate-minhash:v1";

type RecordNearDuplicateSignatureOptions = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  text: string;
};

/**
 * Store the version's signature and band keys, or nothing when the text is
 * too short to compare. A redelivered extraction computes the same signature
 * and band keys, so conflicts are skipped and a run that stopped between the
 * two inserts is completed by the next delivery.
 */
export const recordNearDuplicateSignature = async (
  db: Pick<Transaction, "insert">,
  {
    entityId,
    entityVersionId,
    organizationId,
    workspaceId,
    text,
  }: RecordNearDuplicateSignatureOptions,
): Promise<void> => {
  const seeds = minHashSeeds(
    await contentLookupKey(organizationId, SEED_LOOKUP_VALUE),
  );
  const signature = minHashSignature(text, seeds);
  if (!signature) {
    return;
  }
  const scope = { entityId, entityVersionId, organizationId, workspaceId };
  // audit: skip - derived from text the audited upload already stored
  await db
    .insert(entityVersionMinhashSignatures)
    .values({ ...scope, signature: signatureToBytes(signature) })
    .onConflictDoNothing();
  await db
    .insert(entityVersionMinhashBands)
    .values(lshBandKeys(signature).map((bandKey) => ({ ...scope, bandKey })))
    .onConflictDoNothing();
};
