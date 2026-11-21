/** The per-version MinHash signature written by native extraction. */

import { Result } from "better-result";
import { and, eq, notInArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  entityVersionMinhashBands,
  entityVersionMinhashSignatures,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { keyedContentLookupKey } from "@/api/lib/content-encryption";
import type { ConfigurationError } from "@/api/lib/errors/tagged-errors";
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
 * partway, ends with exactly the latest text's signature and keys. Refuses,
 * recording nothing, where no content key is configured: the hash seeds come
 * only from the organization's keyed lookup key.
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
): Promise<Result<void, ConfigurationError>> => {
  const key = await keyedContentLookupKey(organizationId, SEED_LOOKUP_VALUE);
  if (Result.isError(key)) {
    return Result.err(key.error);
  }
  const signature = minHashSignature(text, minHashSeeds(key.value));
  if (!signature) {
    return Result.ok(undefined);
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
  return Result.ok(undefined);
};
