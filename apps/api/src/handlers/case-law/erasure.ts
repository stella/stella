import { panic, Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawIndexJobs,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  cancelCaseLawCorpusUploadIntents,
  completeCaseLawCorpusUploadIntentCleanups,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import type { CancelledCaseLawCorpusUploadIntent } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { removeDecisionFromIndex } from "@/api/lib/legal-search/case-law-search-index";
import {
  CorpusIndexProjectionSubjectMissingError,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";

/**
 * GDPR redaction / takedown for a case-law decision. Personal data lives
 * in (up to) four places once the migration is underway, and erasure
 * must hit all of them:
 *
 *   1. The corpus index, through the projection queue: clearing the canonical
 *      content moves the decision's desired state to a delete.
 *   2. The pg-fts projection (case_law_search_documents).
 *   3. The object-storage corpus payloads (text/sections/AST).
 *   4. The Postgres canonical columns (fulltext/sections/document_ast).
 *
 * The decision row itself is kept (citation-graph node) but stripped of
 * personal text. `content_hash` is nulled so nothing re-projects the body.
 * The erasure is recorded in case_law_index_jobs.
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
  scopedDb: ScopedDb;
};

const recordFailedRedactionAudit = async ({
  decisionId,
  error,
  scopedDb,
}: FailedRedactionAuditOptions): Promise<void> => {
  const errorMessage =
    error instanceof Error ? error.message : "Unknown corpus redaction error";
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — this insert IS the append-only failed erasure audit row
    return tx.insert(caseLawIndexJobs).values({
      decisionId,
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
  deleteCorpus = deleteCorpusDocument,
}: RedactInput): Promise<RedactCaseLawDecisionOutcome> => {
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
          textS3Key: caseLawDecisions.textS3Key,
          normalizedS3Key: caseLawDecisions.normalizedS3Key,
          astS3Key: caseLawDecisions.astS3Key,
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

  if (corpusErasure.type === "incomplete") {
    // The failed audit row recorded above is the record of this erasure.
    return { type: "corpus-objects-remain", error: corpusErasure.error };
  }

  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — this insert IS the append-only erasure audit row
    return tx.insert(caseLawIndexJobs).values({
      decisionId,
      operation: "redact",
      status: "succeeded",
      contentHash: null,
    });
  });

  return { type: "redacted" };
};
