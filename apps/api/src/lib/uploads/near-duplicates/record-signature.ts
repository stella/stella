/** The per-version MinHash signature written by native extraction. */

import { and, eq, notInArray, sql } from "drizzle-orm";

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
 * too short to compare. New text for the version replaces the signature and
 * its band keys. Every step converges, so a redelivery, or a run that stopped
 * partway, ends with exactly the latest text's signature and keys.
 */
export const recordNearDuplicateSignature = async (
  db: Pick<Transaction, "delete" | "insert">,
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
  const bytes = signatureToBytes(signature);
  const bandKeys = lshBandKeys(signature);
  // audit: skip - derived from text the audited upload already stored
  await db
    .insert(entityVersionMinhashSignatures)
    .values({ ...scope, signature: bytes })
    .onConflictDoUpdate({
      target: entityVersionMinhashSignatures.entityVersionId,
      set: { signature: bytes },
      setWhere: sql`${entityVersionMinhashSignatures.signature} IS DISTINCT FROM excluded.signature`,
    });
  await db
    .delete(entityVersionMinhashBands)
    .where(
      and(
        eq(entityVersionMinhashBands.workspaceId, workspaceId),
        eq(entityVersionMinhashBands.entityVersionId, entityVersionId),
        notInArray(entityVersionMinhashBands.bandKey, bandKeys),
      ),
    );
  await db
    .insert(entityVersionMinhashBands)
    .values(bandKeys.map((bandKey) => ({ ...scope, bandKey })))
    .onConflictDoNothing();
};
