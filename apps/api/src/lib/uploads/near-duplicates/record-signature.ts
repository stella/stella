/** The per-version MinHash signature written by native extraction. */

import { Result } from "better-result";
import { and, eq, notInArray, sql } from "drizzle-orm";

import type { RootDatabase } from "@/api/db/root";
import {
  entityVersionMinhashBands,
  entityVersionMinhashSignatures,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { keyedContentLookupKey } from "@/api/lib/content-encryption";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { lockForWrite } from "@/api/lib/db/lock-for-write";
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
 * Store the version's signature and band keys in one transaction. New text for
 * the version replaces both, and text too short to compare removes them (the
 * band keys cascade with the signature), so a version's rows always describe
 * its latest text. A redelivery of the same text writes nothing new. Refuses,
 * recording nothing, where no content key is configured: the hash seeds come
 * only from the organization's keyed lookup key.
 */
export const recordNearDuplicateSignature = async (
  db: Pick<RootDatabase, "transaction">,
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
  const scope = { entityId, entityVersionId, organizationId, workspaceId };
  await withAggregateTransaction(db, async (tx) => {
    const parents = await lockForWrite(tx, {
      organizationIds: [organizationId],
      workspaceIds: [workspaceId],
    });
    if (
      !parents.organizationIds.has(organizationId) ||
      !parents.workspaceIds.has(workspaceId)
    ) {
      return;
    }
    // audit: skip - derived from text the audited upload already stored
    if (!signature) {
      await tx
        .delete(entityVersionMinhashSignatures)
        .where(
          and(
            eq(entityVersionMinhashSignatures.workspaceId, workspaceId),
            eq(entityVersionMinhashSignatures.entityVersionId, entityVersionId),
          ),
        );
      return;
    }
    const bytes = signatureToBytes(signature);
    const bandKeys = lshBandKeys(signature);
    await tx
      .insert(entityVersionMinhashSignatures)
      .values({ ...scope, signature: bytes })
      .onConflictDoUpdate({
        target: entityVersionMinhashSignatures.entityVersionId,
        set: { signature: bytes },
        setWhere: sql`${entityVersionMinhashSignatures.signature} IS DISTINCT FROM excluded.signature`,
      });
    await tx
      .delete(entityVersionMinhashBands)
      .where(
        and(
          eq(entityVersionMinhashBands.workspaceId, workspaceId),
          eq(entityVersionMinhashBands.entityVersionId, entityVersionId),
          notInArray(entityVersionMinhashBands.bandKey, bandKeys),
        ),
      );
    await tx
      .insert(entityVersionMinhashBands)
      .values(bandKeys.map((bandKey) => ({ ...scope, bandKey })))
      .onConflictDoNothing();
  });
  return Result.ok(undefined);
};
