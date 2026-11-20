import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersionMinhashBands,
  entityVersionMinhashSignatures,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  estimateSimilarity,
  lshBandKeys,
  NEAR_DUPLICATE_THRESHOLD,
  signatureFromBytes,
} from "@/api/lib/uploads/near-duplicates/minhash";

/**
 * Candidates compared exactly per lookup, those sharing the most band keys
 * first; bounds the work as a matter grows.
 */
const MAX_CANDIDATES = 50;

export type SimilarDocument = {
  entityId: SafeId<"entity">;
  entityName: string;
  similarity: number;
};

type FindSimilarDocumentsOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
};

/**
 * The other documents in one matter whose current version reads (almost) the
 * same as this document's current version, most similar first. Other versions
 * of the same document are never reported.
 */
export const findSimilarDocuments = async ({
  tx,
  workspaceId,
  entityId,
}: FindSimilarDocumentsOptions): Promise<SimilarDocument[]> => {
  const [own] = await tx
    .select({ signature: entityVersionMinhashSignatures.signature })
    .from(entityVersionMinhashSignatures)
    .innerJoin(
      entities,
      and(
        eq(
          entities.currentVersionId,
          entityVersionMinhashSignatures.entityVersionId,
        ),
        eq(entities.id, entityId),
        eq(entities.workspaceId, workspaceId),
      ),
    )
    .where(eq(entityVersionMinhashSignatures.workspaceId, workspaceId))
    .limit(1);
  if (!own) {
    return [];
  }
  const signature = signatureFromBytes(own.signature);

  const candidates = await tx
    .select({
      entityId: entities.id,
      entityName: entities.name,
      signature: entityVersionMinhashSignatures.signature,
    })
    .from(entityVersionMinhashSignatures)
    .innerJoin(
      entities,
      and(
        eq(entities.id, entityVersionMinhashSignatures.entityId),
        eq(
          entities.currentVersionId,
          entityVersionMinhashSignatures.entityVersionId,
        ),
        eq(entities.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(entityVersionMinhashSignatures.workspaceId, workspaceId),
        inArray(
          entityVersionMinhashSignatures.entityVersionId,
          tx
            .select({
              entityVersionId: entityVersionMinhashBands.entityVersionId,
            })
            .from(entityVersionMinhashBands)
            .innerJoin(
              entities,
              and(
                eq(entities.id, entityVersionMinhashBands.entityId),
                eq(
                  entities.currentVersionId,
                  entityVersionMinhashBands.entityVersionId,
                ),
                eq(entities.workspaceId, workspaceId),
                eq(entities.kind, "document"),
                ne(entities.id, entityId),
              ),
            )
            .where(
              and(
                eq(entityVersionMinhashBands.workspaceId, workspaceId),
                inArray(
                  entityVersionMinhashBands.bandKey,
                  lshBandKeys(signature),
                ),
              ),
            )
            .groupBy(entityVersionMinhashBands.entityVersionId)
            .orderBy(
              desc(count()),
              asc(entityVersionMinhashBands.entityVersionId),
            )
            .limit(MAX_CANDIDATES),
        ),
      ),
    );

  return candidates
    .map((candidate) => ({
      entityId: candidate.entityId,
      entityName: candidate.entityName,
      similarity: estimateSimilarity(
        signature,
        signatureFromBytes(candidate.signature),
      ),
    }))
    .filter(({ similarity }) => similarity >= NEAR_DUPLICATE_THRESHOLD)
    .toSorted((left, right) => right.similarity - left.similarity);
};
