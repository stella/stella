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
import { eraseCorpusObjects } from "@/api/handlers/case-law/erasure";
import type { CorpusObjectErasure } from "@/api/handlers/case-law/erasure";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  cancelCaseLawCorpusUploadIntents,
  completeCaseLawCorpusUploadIntentCleanup,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { removeDecisionFromIndex } from "@/api/lib/legal-search/case-law-search-index";
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
  scopedDb: ScopedDb;
  /** Test seam; production deletes through the corpus bucket client. */
  deleteCorpus?: typeof deleteCorpusDocument;
};

export type WithdrawCaseLawDecisionDocumentOutcome =
  | { type: "not-found" }
  /** The row keeps its identity and metadata; its document is gone. */
  | { type: "withdrawn" }
  /**
   * Every reader is served nothing, but at least one corpus object still
   * holds the payload. Its pointer columns stay as retry targets.
   */
  | { type: "corpus-objects-remain"; error: unknown };

/**
 * What the fencing transaction settled, so the work after it — index
 * removal, object deletion — runs only where the row was really taken.
 */
type FencedWithdrawal =
  | {
      type: "locked";
      cancelledIntents: Awaited<
        ReturnType<typeof cancelCaseLawCorpusUploadIntents>
      >;
      decision: {
        textS3Key: string | null;
        normalizedS3Key: string | null;
        astS3Key: string | null;
      };
    }
  /** No such row, or none the projection knows: nothing to withdraw. */
  | { type: "missing" }
  /** The fence itself failed, which says nothing about the row. */
  | { type: "lock-failed"; cause: unknown };

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
 */
export const withdrawCaseLawDecisionDocument = async ({
  decisionId,
  scopedDb,
  deleteCorpus = deleteCorpusDocument,
}: WithdrawInput): Promise<
  Result<WithdrawCaseLawDecisionDocumentOutcome, DatabaseError>
> => {
  const fenced = await scopedDb(async (tx): Promise<FencedWithdrawal> => {
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
        .select({
          textS3Key: caseLawDecisions.textS3Key,
          normalizedS3Key: caseLawDecisions.normalizedS3Key,
          astS3Key: caseLawDecisions.astS3Key,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (!decision) {
      return { type: "missing" };
    }

    // audit: skip — withdraws a parser artefact; the replay report records it
    await tx
      .update(caseLawDecisions)
      .set({
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        ...TRIMMED_CORPUS_PAYLOAD_COLUMNS,
        contentHash: null,
        indexedHash: null,
        indexedAt: null,
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
    return { type: "locked", cancelledIntents, decision };
  });

  if (fenced.type === "lock-failed") {
    return Result.err(
      new DatabaseError({
        message: `Case-law withdrawal could not fence ${decisionId}`,
        cause: fenced.cause,
      }),
    );
  }
  if (fenced.type === "missing") {
    return Result.ok({ type: "not-found" });
  }
  const { cancelledIntents, decision } = fenced;

  await removeDecisionFromIndex(decisionId, scopedDb);

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
        step: "withdrawCaseLawDecisionDocument.deleteCorpusDocument",
      });
    }
  }

  const cancelledCleanup = await Promise.allSettled(
    cancelledIntents.map(async (intent) => {
      await deleteCorpus({
        textKey: intent.textKey,
        sectionsKey: intent.sectionsKey,
        astKey: intent.astKey,
      });
      await completeCaseLawCorpusUploadIntentCleanup({
        intentId: intent.id,
        scopedDb,
      });
    }),
  );
  for (const cleanup of cancelledCleanup) {
    if (cleanup.status === "rejected") {
      captureError(cleanup.reason, {
        decisionId,
        step: "withdrawCaseLawDecisionDocument.deleteReservedCorpusUpload",
      });
    }
  }

  if (corpusErasure.type === "incomplete") {
    return Result.ok({
      type: "corpus-objects-remain",
      error: corpusErasure.error,
    });
  }

  // Pointers are cleared only once the objects are gone, so an incomplete
  // deletion keeps exact retry targets while every reader already sees a
  // row with no document.
  await scopedDb(async (tx) => {
    // audit: skip — withdraws a parser artefact; the replay report records it
    await tx
      .update(caseLawDecisions)
      .set({ textS3Key: null, normalizedS3Key: null, astS3Key: null })
      .where(eq(caseLawDecisions.id, decisionId));
  });

  return Result.ok({ type: "withdrawn" });
};
