import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCorpusIndexProjections,
  caseLawDecisions,
  caseLawIndexJobs,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  acquireCaseLawCorpusGenerationLease,
  type CaseLawCorpusGenerationLease,
  removeDecisionFromCorpusIndex,
} from "@/api/handlers/case-law/corpus-index";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import { removeDecisionFromIndex } from "@/api/lib/legal-search/case-law-search-index";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import {
  corpusIndexId,
  isCaseLawCorpusGeneration,
  tryCorpusIndexGeneration,
} from "@/api/lib/legal-search/index-naming";

/**
 * GDPR redaction / takedown for a case-law decision. Personal data lives
 * in (up to) four places once the migration is underway, and erasure
 * must hit all of them:
 *
 *   1. corpus index search index (delete-task) — if configured.
 *   2. The pg-fts projection (case_law_search_documents).
 *   3. The object-storage corpus payloads (text/sections/AST).
 *   4. The Postgres canonical columns (fulltext/sections/document_ast).
 *
 * The decision row itself is kept (citation-graph node) but stripped of
 * personal text. `content_hash` is nulled so neither backfill loop
 * re-indexes the body. The erasure is recorded in case_law_index_jobs.
 *
 * Returns false if the decision does not exist.
 */
type RedactInput = {
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  generation?: string;
};

export const redactCaseLawDecision = async ({
  decisionId,
  scopedDb,
  generation = envBase.LEGAL_SEARCH_INDEX_GENERATION,
}: RedactInput): Promise<boolean> => {
  if (!isCaseLawCorpusGeneration(generation)) {
    const error = new CorpusIndexError({
      message: "Invalid corpus index generation",
    });
    captureError(error, {
      decisionId,
      step: "redactCaseLawDecision.validateGeneration",
    });
    throw error;
  }
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        id: true,
        country: true,
        textS3Key: true,
        normalizedS3Key: true,
        astS3Key: true,
        indexedGeneration: true,
      },
    }),
  );

  if (!decision) {
    return false;
  }

  // 1. pg-fts projection.
  await removeDecisionFromIndex(decisionId, scopedDb);

  // 2. Object-storage corpus payloads. Delete if ANY key is present: a
  // partially ingested decision (e.g. text written but AST not yet) must
  // still have its personal data erased, not skipped.
  let corpusObjectsDeleted = true;
  if (
    decision.textS3Key !== null ||
    decision.normalizedS3Key !== null ||
    decision.astS3Key !== null
  ) {
    try {
      await deleteCorpusDocument({
        textKey: decision.textS3Key,
        sectionsKey: decision.normalizedS3Key,
        astKey: decision.astS3Key,
      });
    } catch (error) {
      corpusObjectsDeleted = false;
      captureError(error, {
        decisionId,
        step: "redactCaseLawDecision.deleteCorpusDocument",
      });
    }
  }

  // 3. Postgres canonical text + key/hash columns. Nulling content_hash
  // stops reads and both backfill loops from treating retained corpus keys
  // as active content. Keys are only retained when S3 deletion failed so a
  // later retry still knows which immutable objects to remove.
  const scrubValues = {
    fulltext: null,
    sections: null,
    documentAst: null,
    ...(corpusObjectsDeleted
      ? {
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
        }
      : {}),
    contentHash: null,
    indexedHash: null,
    // indexedGeneration is intentionally NOT scrubbed here: it records
    // which corpus index holds the indexed copy, and is only cleared
    // below once the index delete-task succeeds, so a failed delete
    // keeps the retry target.
    indexedAt: null,
  };

  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
    return tx
      .update(caseLawDecisions)
      .set(scrubValues)
      .where(eq(caseLawDecisions.id, decisionId));
  });

  // 4. corpus index (delete-task + audit row). Skipped when corpus index
  // isn't configured. This intentionally happens after local authoritative
  // stores are scrubbed, so a transient index failure cannot leave the
  // DB/S3 payloads unerased. The copy is deleted from the row's recorded
  // index (a corrected country can leave it under a different jurisdiction
  // index) and from the current-country index in case a move was
  // mid-flight; the recorded pointer is only cleared once both succeed.
  let auditedViaCorpusIndex = false;
  if (envBase.CORPUS_INDEX_ENDPOINT !== undefined) {
    const projectionTargets = await scopedDb((tx) =>
      tx
        .select({
          generation: caseLawCorpusIndexProjections.generation,
          indexId: caseLawCorpusIndexProjections.indexId,
          pendingIndexIds: caseLawCorpusIndexProjections.pendingIndexIds,
        })
        .from(caseLawCorpusIndexProjections)
        .where(eq(caseLawCorpusIndexProjections.decisionId, decisionId)),
    );
    const targets = new Map<string, Set<string>>();
    const addTarget = (targetGeneration: string, indexId: string) => {
      const indexes = targets.get(targetGeneration);
      if (indexes) {
        indexes.add(indexId);
      } else {
        targets.set(targetGeneration, new Set([indexId]));
      }
    };
    addTarget(generation, corpusIndexId(generation, decision.country));
    if (decision.indexedGeneration !== null) {
      const storedGeneration = tryCorpusIndexGeneration(
        decision.indexedGeneration,
      );
      if (storedGeneration === null) {
        captureError(
          new CorpusIndexError({
            message: "Stored corpus index target is not a physical index id",
          }),
          {
            decisionId,
            indexedGeneration: decision.indexedGeneration,
            step: "redactCaseLawDecision.readStoredIndexTarget",
          },
        );
      } else {
        addTarget(storedGeneration, decision.indexedGeneration);
      }
    }
    for (const projection of projectionTargets) {
      // The deterministic target also covers an append that landed before its
      // projection CAS. Such an orphan has no persisted index_id to discover.
      addTarget(
        projection.generation,
        corpusIndexId(projection.generation, decision.country),
      );
      if (projection.indexId !== null) {
        addTarget(projection.generation, projection.indexId);
      }
      for (const pendingIndexId of projection.pendingIndexIds) {
        addTarget(projection.generation, pendingIndexId);
      }
    }

    const leases = new Map<string, CaseLawCorpusGenerationLease>();
    try {
      const claims = await Promise.all(
        [...targets.keys()].sort().map(async (targetGeneration) => ({
          lease: await acquireCaseLawCorpusGenerationLease({
            generation: targetGeneration,
            scopedDb,
          }),
          targetGeneration,
        })),
      );
      for (const { lease, targetGeneration } of claims) {
        if (lease) {
          leases.set(targetGeneration, lease);
        }
      }
      if (leases.size !== targets.size) {
        const error = new ConcurrentModificationError({
          message: "Case-law corpus generation is being written",
        });
        // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
        await scopedDb((tx) => {
          // audit: skip — this insert IS the append-only failed erasure audit row
          return tx.insert(caseLawIndexJobs).values({
            decisionId,
            generation,
            operation: "redact",
            status: "failed",
            contentHash: null,
            errorMessage: error.message,
          });
        });
        captureError(error, {
          decisionId,
          step: "redactCaseLawDecision.acquireGenerationLeases",
        });
        throw error;
      }

      // Attempt every target: one transient error must not leave copies in
      // the others undeleted. Missing retired indexes are already successful
      // fixed points in the shared indexer.
      let firstError: CorpusIndexError | null = null;
      const removals = await Promise.all(
        [...targets].flatMap(([targetGeneration, indexes]) => {
          const lease = leases.get(targetGeneration);
          if (!lease) {
            throw new ConcurrentModificationError({
              message: "Case-law corpus generation lease disappeared",
            });
          }
          return [...indexes].map(
            async (indexId) =>
              await removeDecisionFromCorpusIndex({
                beforeRemoteEffect: lease.beforeRemoteEffect,
                entityId: decisionId,
                indexId,
                onLeaseLost: async () =>
                  await lease.recoverRemoteEffectLeaseLoss({
                    entityIds: [decisionId],
                    indexId,
                  }),
                operation: "redact",
                scopedDb,
              }),
          );
        }),
      );
      for (const removed of removals) {
        if (removed.isErr()) {
          firstError ??= removed.error;
        }
      }
      if (firstError) {
        // Keep every projection and indexedGeneration target for a durable
        // retry. The local canonical stores have already been scrubbed.
        // eslint-disable-next-line no-throw-literal -- CorpusIndexError (TaggedError); rethrow so the caller retries the redaction
        throw firstError;
      }
      await scopedDb(async (tx) => {
        for (const lease of leases.values()) {
          // oxlint-disable-next-line no-await-in-loop -- one transaction renews every held generation fence before clearing durable targets
          await lease.beforeDatabaseMark(tx);
        }
        const stillErased = (
          await tx
            .select({ id: caseLawDecisions.id })
            .from(caseLawDecisions)
            .where(
              and(
                eq(caseLawDecisions.id, decisionId),
                isNull(caseLawDecisions.contentHash),
              ),
            )
            .for("update")
            .limit(1)
        ).at(0);
        if (!stillErased) {
          // A concurrent restore owns the canonical content, but the fenced
          // deletes may have removed its newly indexed copy. Invalidating the
          // successful marker fires the projection trigger, which durably
          // requeues the restored hash for every tracked generation.
          // audit: skip — search index maintenance; rebuilds derived state
          await tx
            .update(caseLawDecisions)
            .set({ indexedAt: null, indexedHash: null })
            .where(
              and(
                eq(caseLawDecisions.id, decisionId),
                isNotNull(caseLawDecisions.contentHash),
              ),
            );
          return;
        }
        // audit: skip — GDPR redaction bookkeeping; recorded in case_law_index_jobs above
        await tx
          .update(caseLawDecisions)
          .set({ indexedGeneration: null })
          .where(eq(caseLawDecisions.id, decisionId));
        await tx
          .delete(caseLawCorpusIndexProjections)
          .where(eq(caseLawCorpusIndexProjections.decisionId, decisionId));
      });
    } finally {
      await Promise.all(
        [...leases.values()].toReversed().map(async (lease) => {
          await lease.release();
        }),
      );
    }
    auditedViaCorpusIndex = true;
  }

  // Ensure the erasure is auditable even when corpus index isn't configured.
  if (!auditedViaCorpusIndex) {
    // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    await scopedDb((tx) => {
      // audit: skip — this insert IS the append-only erasure audit row
      return tx.insert(caseLawIndexJobs).values({
        decisionId,
        generation,
        operation: "redact",
        status: "succeeded",
        contentHash: null,
      });
    });
  }

  return true;
};
