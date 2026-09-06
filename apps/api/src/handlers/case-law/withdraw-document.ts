/**
 * Take back the document a decision holds, without tombstoning the row.
 *
 * Separate from `erasure.ts` on purpose. A redaction is a takedown: it
 * marks the row erased for good, and every later pass — the replay
 * included — steps over it. This is the opposite claim about the same
 * columns: what was stored was never a document, the row is otherwise
 * fine, and a parser fix may still turn its stored payload into one.
 * The two share the object-deletion step and nothing else.
 */

import { Result } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { eraseCorpusObjects } from "@/api/handlers/case-law/erasure";
import type { CorpusObjectErasure } from "@/api/handlers/case-law/erasure";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  cancelCaseLawCorpusUploadIntents,
  completeCaseLawCorpusUploadIntentCleanups,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { removeDecisionFromIndex } from "@/api/lib/legal-search/case-law-search-index";
import { recordCorpusWithdrawalAuditEvent } from "@/api/lib/legal-search/corpus-index-job-audit";
import {
  CorpusIndexProjectionSubjectMissingError,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  deleteCorpusDocument,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";

type WithdrawInput = {
  decisionId: SafeId<"caseLawDecision">;
  /**
   * Why the document is being taken back, recorded verbatim on the audit
   * row. The caller states it because only the caller knows: the row
   * itself cannot say what its payload re-parsed to.
   */
  reason: string;
  scopedDb: ScopedDb;
  /** Generation the audit row is filed under. */
  generation?: string;
  /** Test seam; production deletes through the corpus bucket client. */
  deleteCorpus?: typeof deleteCorpusDocument;
};

export type WithdrawCaseLawDecisionDocumentOutcome =
  | { type: "not-found" }
  /** The row keeps its identity and metadata; its document is gone. */
  | { type: "withdrawn" }
  /**
   * A corpus object still holds the payload, so nothing was written: the
   * row keeps its document and the next run retries the whole withdrawal
   * rather than resuming a half-finished one.
   */
  | { type: "corpus-objects-remain"; error: unknown };

/** What the writing transaction settled. */
type WithdrawalWrite =
  | {
      type: "written";
      cancelledIntents: Awaited<
        ReturnType<typeof cancelCaseLawCorpusUploadIntents>
      >;
    }
  /** No such row, or none the projection knows: nothing to withdraw. */
  | { type: "missing" }
  /** The fence itself failed, which says nothing about the row. */
  | { type: "lock-failed"; cause: unknown };

type CorpusPointers = {
  textS3Key: string | null;
  normalizedS3Key: string | null;
  astS3Key: string | null;
};

const holdsCorpusObject = ({
  textS3Key,
  normalizedS3Key,
  astS3Key,
}: CorpusPointers): boolean =>
  textS3Key !== null || normalizedS3Key !== null || astS3Key !== null;

/**
 * Take back a decision's stored document, keeping the decision.
 *
 * The row's text is what a parser derived, and a parser fix can decide
 * that what it once derived was never a document — a page the publisher
 * served where a decision would be, say. Re-parsing that row produces no
 * result at all, so the pipeline has nothing to write over it and the
 * text would stand indefinitely.
 *
 * Not a redaction, and deliberately not `redactCaseLawDecision`: a
 * redaction is a tombstone, and a tombstoned row is excluded from every
 * later replay, so the same publisher serving the real document later
 * could never restore it. Here the identity, the metadata and the stored
 * raw payload stay exactly as they are, and only the derived document
 * goes. Nulling the content hash is what the projection reads: its
 * descriptor turns a row with no hash into an erase for every generation.
 *
 * The corpus objects are deleted before the row stops naming them, and a
 * deletion that cannot be confirmed abandons the withdrawal with nothing
 * written. The alternative — empty the row first — reports a document
 * withdrawn while an object still serves it, and leaves nothing for a
 * later run to retry, since the row no longer looks withdrawable. The
 * cost of this order is a short window where the row names objects that
 * are already gone; a reader in that window is served no payload, which
 * is what the row is about to say anyway.
 */
export const withdrawCaseLawDecisionDocument = async ({
  decisionId,
  reason,
  scopedDb,
  generation = envBase.LEGAL_SEARCH_INDEX_GENERATION,
  deleteCorpus = deleteCorpusDocument,
}: WithdrawInput): Promise<
  Result<WithdrawCaseLawDecisionDocumentOutcome, DatabaseError>
> => {
  const pointers = (
    await scopedDb((tx) =>
      tx
        .select({
          textS3Key: caseLawDecisions.textS3Key,
          normalizedS3Key: caseLawDecisions.normalizedS3Key,
          astS3Key: caseLawDecisions.astS3Key,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .limit(1),
    )
  ).at(0);
  if (pointers === undefined) {
    return Result.ok({ type: "not-found" });
  }

  let corpusErasure: CorpusObjectErasure = { type: "deleted" };
  if (holdsCorpusObject(pointers)) {
    corpusErasure = await eraseCorpusObjects({
      keys: {
        textKey: pointers.textS3Key,
        sectionsKey: pointers.normalizedS3Key,
        astKey: pointers.astS3Key,
      },
      deleteCorpus,
    });
  }
  if (corpusErasure.type === "incomplete") {
    captureError(corpusErasure.error, {
      decisionId,
      step: "withdrawCaseLawDecisionDocument.deleteCorpusDocument",
    });
    return Result.ok({
      type: "corpus-objects-remain",
      error: corpusErasure.error,
    });
  }

  const written = await scopedDb(async (tx): Promise<WithdrawalWrite> => {
    const sourceLock = await Result.tryPromise({
      try: async () =>
        await lockActiveCorpusProjectionSourceTx(tx, {
          family: "case_law",
          entityId: decisionId,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(sourceLock)) {
      // A subject the projection does not know is the row not being there,
      // which is an answer. Anything else — a lock timeout, a dropped
      // connection — says nothing about the row, and is carried back so the
      // caller can hold its place and try again.
      return sourceLock.error instanceof
        CorpusIndexProjectionSubjectMissingError
        ? { type: "missing" }
        : { type: "lock-failed", cause: sourceLock.error };
    }
    const decision = (
      await tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (decision === undefined) {
      return { type: "missing" };
    }

    // The audit row and the columns it describes are written together, so
    // a withdrawal cannot land without a record of why.
    await recordCorpusWithdrawalAuditEvent(tx, {
      decisionId,
      generation,
      reason,
    });
    await tx
      .update(caseLawDecisions)
      .set({
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        ...TRIMMED_CORPUS_PAYLOAD_COLUMNS,
        contentHash: null,
        indexedHash: null,
        indexedAt: null,
        textS3Key: null,
        normalizedS3Key: null,
        astS3Key: null,
      })
      .where(eq(caseLawDecisions.id, decisionId));
    // A mirror write already in flight would otherwise settle the payload
    // back onto the row it was just taken off.
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
    return { type: "written", cancelledIntents };
  });

  if (written.type === "lock-failed") {
    return Result.err(
      new DatabaseError({
        message: `Case-law withdrawal could not fence ${decisionId}`,
        cause: written.cause,
      }),
    );
  }
  if (written.type === "missing") {
    return Result.ok({ type: "not-found" });
  }

  await removeDecisionFromIndex(decisionId, scopedDb);

  const cancelledCleanup = await Promise.allSettled(
    written.cancelledIntents.map(async (intent) => {
      await deleteCorpus({
        textKey: intent.textKey,
        sectionsKey: intent.sectionsKey,
        astKey: intent.astKey,
      });
      return intent.id;
    }),
  );
  const cleanedIntentIds: SafeId<"caseLawCorpusUploadIntent">[] = [];
  for (const cleanup of cancelledCleanup) {
    if (cleanup.status === "rejected") {
      captureError(cleanup.reason, {
        decisionId,
        step: "withdrawCaseLawDecisionDocument.deleteReservedCorpusUpload",
      });
      continue;
    }
    cleanedIntentIds.push(cleanup.value);
  }
  // Only the intents whose objects are gone lose their row; the rest stay
  // retry targets.
  await completeCaseLawCorpusUploadIntentCleanups({
    intentIds: cleanedIntentIds,
    scopedDb,
  });

  return Result.ok({ type: "withdrawn" });
};
