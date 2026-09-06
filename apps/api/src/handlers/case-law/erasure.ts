import { panic, Result, TaggedError } from "better-result";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
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
import { settleAll, settleAllCleanup } from "@/api/lib/corpus-index/core";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import {
  cancelCaseLawCorpusUploadIntents,
  completeCaseLawCorpusUploadIntentCleanups,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import type { CancelledCaseLawCorpusUploadIntent } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { removeDecisionFromIndex } from "@/api/lib/legal-search/case-law-search-index";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import {
  CorpusIndexProjectionSubjectMissingError,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import {
  corpusIndexId,
  isCaseLawCorpusGeneration,
  isCorpusIndexJurisdiction,
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
 */
type EraseCancelledIntentObjectsOptions = {
  cancelledIntents: readonly CancelledCaseLawCorpusUploadIntent[];
  deleteCorpus?: typeof deleteCorpusDocument;
};

type CancelledIntentErasure = {
  /** Intents whose every object is gone; only these may lose their row. */
  cleanedIntentIds: SafeId<"caseLawCorpusUploadIntent">[];
  /** Intents still holding a payload; their rows stay as retry targets. */
  incomplete: {
    intentId: SafeId<"caseLawCorpusUploadIntent">;
    error: unknown;
  }[];
};

/**
 * Erase the objects of every cancelled upload intent and split the intents
 * by outcome. A retained shared object or a failed DELETE keeps the intent
 * on the retry path exactly as it keeps a decision's pointer columns.
 */
export const eraseCancelledIntentObjects = async ({
  cancelledIntents,
  deleteCorpus = deleteCorpusDocument,
}: EraseCancelledIntentObjectsOptions): Promise<CancelledIntentErasure> => {
  const erasures = await Promise.all(
    cancelledIntents.map(async (intent) => ({
      intentId: intent.id,
      erasure: await eraseCorpusObjects({
        keys: {
          textKey: intent.textKey,
          sectionsKey: intent.sectionsKey,
          astKey: intent.astKey,
        },
        deleteCorpus,
      }),
    })),
  );
  const result: CancelledIntentErasure = {
    cleanedIntentIds: [],
    incomplete: [],
  };
  for (const { intentId, erasure } of erasures) {
    if (erasure.type === "deleted") {
      result.cleanedIntentIds.push(intentId);
      continue;
    }
    result.incomplete.push({ intentId, error: erasure.error });
  }
  return result;
};

type RedactInput = {
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  generation?: string;
  /** Test seam; production deletes through the corpus bucket client. */
  deleteCorpus?: typeof deleteCorpusDocument;
};

export type RedactCaseLawDecisionOutcome =
  | { type: "not-found" }
  /** Every store was scrubbed. */
  | { type: "redacted" }
  /**
   * The row is redacted and every index copy removed, but at least one
   * corpus object still holds the payload. Its pointer columns are kept as
   * retry targets and a failed audit row records the cause.
   */
  | { type: "corpus-objects-remain"; error: unknown };

/** A pointer named a range inside an object that holds other members. */
export class CorpusObjectRetainedError extends TaggedError(
  "CorpusObjectRetainedError",
)<{
  message: string;
  retained: string[];
}> {}

/**
 * Whether every corpus object a decision pointed at is gone.
 *
 * Exported because the withdrawal path deletes the same objects and must
 * report the same partial outcome; one definition keeps the two from
 * disagreeing about what "still there" means.
 */
export type CorpusObjectErasure =
  | { type: "deleted" }
  /**
   * At least one object still holds the payload, whether its DELETE failed
   * or it holds other members and was left in place. Either way the pointer
   * columns must stay as retry targets.
   */
  | { type: "incomplete"; error: unknown };

type EraseCorpusObjectsOptions = {
  keys: Parameters<typeof deleteCorpusDocument>[0];
  deleteCorpus?: typeof deleteCorpusDocument;
};

/**
 * Delete a decision's corpus objects and say whether every payload is gone.
 * A pointer into an object that holds other members leaves that object in
 * place, so its payload is not erased; that is reported the same way as a
 * failed DELETE rather than as success.
 */
export const eraseCorpusObjects = async ({
  keys,
  deleteCorpus = deleteCorpusDocument,
}: EraseCorpusObjectsOptions): Promise<CorpusObjectErasure> => {
  const outcome = await Result.tryPromise({
    try: async () => await deleteCorpus(keys),
    // The cause travels unchanged into the audit row and telemetry.
    catch: (cause) => cause,
  });
  if (Result.isError(outcome)) {
    return { type: "incomplete", error: outcome.error };
  }
  switch (outcome.value.type) {
    case "deleted":
      return { type: "deleted" };
    case "shared-object-retained": {
      const retained = outcome.value.retained.map(formatCorpusLocation);
      return {
        type: "incomplete",
        error: new CorpusObjectRetainedError({
          message: `Corpus objects hold other members and are left in place: ${retained.join(", ")}`,
          retained,
        }),
      };
    }
    default: {
      outcome.value satisfies never;
      return panic(`Unhandled value: ${String(outcome.value)}`);
    }
  }
};

type FailedRedactionAuditOptions = {
  decisionId: SafeId<"caseLawDecision">;
  error: unknown;
  generation: string;
  scopedDb: ScopedDb;
};

const recordFailedRedactionAudit = async ({
  decisionId,
  error,
  generation,
  scopedDb,
}: FailedRedactionAuditOptions): Promise<void> => {
  const errorMessage =
    error instanceof Error ? error.message : "Unknown corpus redaction error";
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — this insert IS the append-only failed erasure audit row
    return tx.insert(caseLawIndexJobs).values({
      decisionId,
      generation,
      operation: "redact",
      status: "failed",
      contentHash: null,
      errorMessage: errorMessage.slice(0, 2048),
    });
  });
};

export const redactCaseLawDecision = async ({
  decisionId,
  scopedDb,
  generation = envBase.LEGAL_SEARCH_INDEX_GENERATION,
  deleteCorpus = deleteCorpusDocument,
}: RedactInput): Promise<RedactCaseLawDecisionOutcome> => {
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
  const fenced = await scopedDb(async (tx) => {
    const sourceLock = await Result.tryPromise({
      try: async () =>
        await lockActiveCorpusProjectionSourceTx(tx, {
          family: "case_law",
          entityId: decisionId,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(sourceLock)) {
      if (
        sourceLock.error instanceof CorpusIndexProjectionSubjectMissingError
      ) {
        return null;
      }
      throw sourceLock.error;
    }
    const decision = (
      await tx
        .select({
          id: caseLawDecisions.id,
          country: caseLawDecisions.country,
          textS3Key: caseLawDecisions.textS3Key,
          normalizedS3Key: caseLawDecisions.normalizedS3Key,
          astS3Key: caseLawDecisions.astS3Key,
          indexedGeneration: caseLawDecisions.indexedGeneration,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (!decision) {
      return null;
    }

    // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
    await tx
      .update(caseLawDecisions)
      .set({
        redactedAt: decision.redactedAt ?? new Date(),
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        fulltext: null,
        sections: null,
        documentAst: null,
        contentHash: null,
        indexedHash: null,
        indexedAt: null,
      })
      .where(eq(caseLawDecisions.id, decisionId));
    const cancelledIntents = await cancelCaseLawCorpusUploadIntents({
      decisionId,
      tx,
    });
    if (sourceLock.value !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: sourceLock.value,
        subject: { family: "case_law", entityId: decisionId },
      });
    }
    return { cancelledIntents, decision };
  });

  if (!fenced) {
    return { type: "not-found" };
  }
  const { cancelledIntents, decision } = fenced;

  const storedIndexTarget = (() => {
    if (decision.indexedGeneration === null) {
      return null;
    }
    const storedGeneration = tryCorpusIndexGeneration(
      decision.indexedGeneration,
    );
    if (storedGeneration !== null) {
      return {
        generation: storedGeneration,
        indexId: decision.indexedGeneration,
      };
    }
    const error = new CorpusIndexError({
      message: "Stored corpus index target is not a physical index id",
    });
    captureError(error, {
      decisionId,
      indexedGeneration: decision.indexedGeneration,
      step: "redactCaseLawDecision.validateStoredIndexTarget",
    });
    throw error;
  })();

  // 1. pg-fts projection.
  await removeDecisionFromIndex(decisionId, scopedDb);

  // 2. Object-storage corpus payloads. Delete if ANY key is present: a
  // partially ingested decision (e.g. text written but AST not yet) must
  // still have its personal data erased, not skipped. An incomplete erasure
  // (a failed DELETE, or an object left in place because it holds other
  // members) is recorded as a failed audit row so the outcome is visible.
  let corpusErasure: CorpusObjectErasure = { type: "deleted" };
  if (
    decision.textS3Key !== null ||
    decision.normalizedS3Key !== null ||
    decision.astS3Key !== null
  ) {
    corpusErasure = await eraseCorpusObjects({
      keys: {
        textKey: decision.textS3Key,
        sectionsKey: decision.normalizedS3Key,
        astKey: decision.astS3Key,
      },
      deleteCorpus,
    });
    if (corpusErasure.type === "incomplete") {
      captureError(corpusErasure.error, {
        decisionId,
        step: "redactCaseLawDecision.deleteCorpusDocument",
      });
      await recordFailedRedactionAudit({
        decisionId,
        error: corpusErasure.error,
        generation,
        scopedDb,
      });
    }
  }

  // Reserved uploads cancelled under the decision lock go the same way as
  // the decision's own payloads: only an intent whose objects are all gone
  // loses its row, the rest stay retry targets. The batched row delete is
  // failure-isolated the way the per-intent deletes it replaced were: a
  // redaction that has already scrubbed the objects must go on to scrub the
  // pointers and the index, and a retained cleanup row is a retry target,
  // not a reason to stop.
  const { cleanedIntentIds, incomplete } = await eraseCancelledIntentObjects({
    cancelledIntents,
    deleteCorpus,
  });
  for (const { error } of incomplete) {
    captureError(error, {
      decisionId,
      step: "redactCaseLawDecision.deleteReservedCorpusUpload",
    });
  }
  const intentCleanup = await Result.tryPromise({
    try: async () =>
      await completeCaseLawCorpusUploadIntentCleanups({
        intentIds: cleanedIntentIds,
        scopedDb,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(intentCleanup)) {
    captureError(intentCleanup.error, {
      decisionId,
      step: "redactCaseLawDecision.completeReservedCorpusUploadCleanup",
    });
  }

  // Clear pointers only once every object is gone; an incomplete erasure
  // retains exact retry targets while the tombstone already blocks every
  // reader.
  if (corpusErasure.type === "deleted") {
    // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    await scopedDb((tx) => {
      // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
      return tx
        .update(caseLawDecisions)
        .set({ textS3Key: null, normalizedS3Key: null, astS3Key: null })
        .where(eq(caseLawDecisions.id, decisionId));
    });
  }

  // 4. corpus index (delete-task + audit row). Skipped when corpus index
  // isn't configured. This intentionally happens after local authoritative
  // stores are scrubbed, so a transient index failure cannot leave the
  // DB/S3 payloads unerased. The copy is deleted from the row's recorded
  // index (a corrected country can leave it under a different jurisdiction
  // index) and from the current-country index in case a move was
  // mid-flight; the recorded pointer is only cleared once both succeed.
  let auditedViaCorpusIndex = false;
  if (
    envBase.CORPUS_INDEX_ENDPOINT !== undefined ||
    envBase.CORPUS_INDEX_Q09_ENDPOINT !== undefined
  ) {
    const projectionTargets = await scopedDb((tx) =>
      tx
        .select({
          generation: caseLawCorpusIndexProjections.generation,
          indexId: caseLawCorpusIndexProjections.indexId,
          pendingIndexIds: caseLawCorpusIndexProjections.pendingIndexIds,
          pendingRevision: caseLawCorpusIndexProjections.pendingRevision,
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
    if (isCorpusIndexJurisdiction(decision.country)) {
      addTarget(generation, corpusIndexId(generation, decision.country));
    }
    if (storedIndexTarget !== null) {
      addTarget(storedIndexTarget.generation, storedIndexTarget.indexId);
    }
    for (const projection of projectionTargets) {
      // The deterministic target also covers an append that landed before its
      // projection CAS. Such an orphan has no persisted index_id to discover.
      if (isCorpusIndexJurisdiction(decision.country)) {
        addTarget(
          projection.generation,
          corpusIndexId(projection.generation, decision.country),
        );
      }
      if (projection.indexId !== null) {
        addTarget(projection.generation, projection.indexId);
      }
      for (const pendingIndexId of projection.pendingIndexIds) {
        addTarget(projection.generation, pendingIndexId);
      }
    }

    const leases = new Map<string, CaseLawCorpusGenerationLease>();
    try {
      const claimOutcomes = await Promise.allSettled(
        [...targets.keys()].sort().map(async (targetGeneration) => ({
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded fan-out: one lease per corpus generation, each with its own fencing token
          lease: await acquireCaseLawCorpusGenerationLease({
            generation: targetGeneration,
            scopedDb,
          }),
          targetGeneration,
        })),
      );
      let firstClaimError: unknown;
      let claimRejected = false;
      for (const outcome of claimOutcomes) {
        if (outcome.status === "rejected") {
          if (!claimRejected) {
            firstClaimError = outcome.reason;
            claimRejected = true;
          }
          continue;
        }
        const { lease, targetGeneration } = outcome.value;
        if (lease) {
          leases.set(targetGeneration, lease);
        }
      }
      if (claimRejected) {
        await recordFailedRedactionAudit({
          decisionId,
          error: firstClaimError,
          generation,
          scopedDb,
        });
        throw firstClaimError;
      }
      if (leases.size !== targets.size) {
        const error = new ConcurrentModificationError({
          message: "Case-law corpus generation is being written",
        });
        await recordFailedRedactionAudit({
          decisionId,
          error,
          generation,
          scopedDb,
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
      const removals = await settleAll(
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
        throw firstError;
      }
      await scopedDb(async (tx) => {
        for (const lease of leases.values()) {
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- each lease renews under its own fencing token before the shared database mark
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
        if (projectionTargets.length > 0) {
          await tx
            .delete(caseLawCorpusIndexProjections)
            .where(
              and(
                eq(caseLawCorpusIndexProjections.decisionId, decisionId),
                or(
                  ...projectionTargets.map((projection) =>
                    and(
                      eq(
                        caseLawCorpusIndexProjections.generation,
                        projection.generation,
                      ),
                      eq(
                        caseLawCorpusIndexProjections.pendingRevision,
                        projection.pendingRevision,
                      ),
                    ),
                  ),
                ),
              ),
            );
        }
      });
    } finally {
      await settleAllCleanup(
        [...leases.values()].toReversed().map(async (lease) => {
          await lease.release();
        }),
        (error) =>
          captureError(error, {
            decisionId,
            step: "redactCaseLawDecision.releaseGenerationLeases",
          }),
      );
    }
    // Every target removal writes its own durable index-job record. With no
    // target, no corpus audit exists, so the fallback audit below must land.
    auditedViaCorpusIndex = targets.size > 0;
  }

  if (corpusErasure.type === "incomplete") {
    // The failed audit row recorded above is the record of this erasure.
    return { type: "corpus-objects-remain", error: corpusErasure.error };
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

  return { type: "redacted" };
};
