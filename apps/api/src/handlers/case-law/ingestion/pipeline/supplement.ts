import { Result, panic } from "better-result";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { caseLawDecisionSupplements, caseLawDecisions } from "@/api/db/schema";
import type { StoredRawReadError } from "@/api/handlers/case-law/ingestion/adapter";
import { absorbComposedSupplementRows } from "@/api/handlers/case-law/ingestion/pipeline/composed-supplements";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { CASE_LAW_CORPUS_DEPENDENCIES } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import {
  wrappedErrorDetail,
  PROCESS_DECISION_STATUS,
  PROCESS_DECISION_RETRY_REASON,
  SUPPLEMENT_RETRY_REASON,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import {
  RAW_OBJECT_COPY_TIMEOUT_MS,
  writeOwnedRawPayload,
} from "@/api/handlers/case-law/ingestion/pipeline/raw-payload";
import { rebuildStoredJudgment } from "@/api/handlers/case-law/ingestion/pipeline/stored-judgment";
import {
  SUPPLEMENT_JUDGMENT_UNREADABLE,
  SUPPLEMENT_JUDGMENT_READ_FAILED,
  SUPPLEMENT_STANDALONE_REASON,
} from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";
import type {
  SupplementStandaloneReason,
  SupplementDisposition,
  ProcessSupplementResult,
  ProcessSupplementOptions,
} from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { absorbStandaloneSupplementRow } from "@/api/handlers/case-law/ingestion/supplement-absorption";
import {
  detachSupplement,
  lockSupplementTarget,
  selectRulingsUnder,
  selectSupplementJudgment,
  supplementCanJoin,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import type { SupplementTargetKey } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import {
  classifyCaseLawRawKey,
  deleteRawKeys,
  openRawSourceWriteWindow,
  RAW_KEY_OWNERSHIP,
  RAW_SOURCE_FAMILY,
} from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";

type SupplementJudgmentRow = {
  id: SafeId<"caseLawDecision">;
  redacted: boolean;
};

/**
 * Store one supplement and put it where it belongs: inside its judgment's
 * document when a stored ruling is its judgment, otherwise as a decision of
 * its own until one is.
 *
 * The judgment is composed by writing it again from its own stored payload,
 * through `processDecision`: that write reads the supplement back, composes
 * it, re-extracts the citations over the whole document, and records the
 * merge in its own transaction. Replay-safe by construction: a supplement
 * whose current version its judgment already holds is a fixed point, and a
 * failure anywhere leaves it parked for the next observation of either
 * document.
 */
export const processSupplement = async ({
  supplement,
  sourceId,
  scopedDb,
  observedAt,
  nextObservationOrder,
  reparseStoredRaw,
  readStoredRaw,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
  polarityRules,
  absorb = absorbStandaloneSupplementRow,
}: ProcessSupplementOptions): Promise<ProcessSupplementResult> => {
  const { sourceDocumentId } = supplement.document;
  const document = sanitizeResult(supplement.document);
  const key: SupplementTargetKey = {
    sourceId,
    court: document.court,
    caseNumber: document.caseNumber,
    language: document.language,
  };

  // The publisher's response is stored under the decision that owns the
  // supplement: its judgment once it joins one, its own standalone row until
  // then. Which one is known only once it is placed, so the row's pointer is
  // written by the placement (`pointRawAt`), and an erasure of either owner
  // reaches it by that owner's prefix.
  const rawContentType = document.sourceRawContentType ?? "text/plain";
  // Opened before the read below that proves the judgment live, as a
  // decision's own write opens it; see `openRawSourceWriteWindow`.
  const rawWriteWindow = openRawSourceWriteWindow();

  const content = {
    kind: supplement.kind,
    caseNumber: document.caseNumber,
    court: document.court,
    language: document.language,
    latestDecisionDate: supplement.target.latestDecisionDate ?? null,
    judgmentDecisionTypes: [...supplement.target.decisionTypes],
    fulltext: document.fulltext ?? null,
    documentAst: document.documentAst,
    sourceHash: document.rawHash,
    sourceUrl: document.sourceUrl ?? null,
    documentUrl: document.documentUrl ?? null,
    metadata: document.metadata,
  };
  const placed = await scopedDb(async (tx) => {
    await lockSupplementTarget(tx, key);
    const erasedOwn = (
      await tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
            isNotNull(caseLawDecisions.redactedAt),
          ),
        )
        .limit(1)
    ).at(0);
    if (erasedOwn !== undefined) {
      // audit: skip — background case-law ingestion; public case-law data
      await tx
        .delete(caseLawDecisionSupplements)
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
          ),
        );
      return { type: "erased" as const, decisionId: erasedOwn.id };
    }
    // audit: skip — background case-law ingestion; public case-law data
    const [row] = await tx
      .insert(caseLawDecisionSupplements)
      .values({ sourceId, sourceDocumentId, observedAt, ...content })
      .onConflictDoUpdate({
        target: [
          caseLawDecisionSupplements.sourceId,
          caseLawDecisionSupplements.sourceDocumentId,
        ],
        set: { ...content, observedAt, updatedAt: new Date() },
      })
      .returning({
        decisionId: caseLawDecisionSupplements.decisionId,
        mergedSourceHash: caseLawDecisionSupplements.mergedSourceHash,
        sourceHash: caseLawDecisionSupplements.sourceHash,
      });
    if (row === undefined) {
      return panic("Supplement upsert returned no row");
    }
    const rulings = await selectRulingsUnder(tx, {
      key,
      decisionTypes: supplement.target.decisionTypes,
    });
    const selection = selectSupplementJudgment({
      target: supplement.target,
      candidates: rulings,
    });
    // A merged supplement stays with its judgment even where a ruling stored
    // since would now be picked: its text is in that judgment's document, and
    // moving it would leave the text there. Only a correction that leaves the
    // holder no longer a ruling it can join moves it.
    const holder =
      row.decisionId === null
        ? undefined
        : rulings.find(({ id }) => id === row.decisionId);
    const leavesHolder =
      row.decisionId !== null &&
      (holder === undefined ||
        !supplementCanJoin({ target: supplement.target, candidate: holder }));
    const judgment = ((): SupplementJudgmentRow | null => {
      if (leavesHolder) {
        return null;
      }
      if (row.decisionId !== null) {
        return { id: row.decisionId, redacted: holder?.redacted === true };
      }
      return selection.type === "judgment" ? selection.judgment : null;
    })();
    if (judgment?.redacted === true) {
      // A takedown covers the reasons of the decision it took down, as its
      // erasure removes those already merged: nothing of them is kept.
      // audit: skip — background case-law ingestion; public case-law data
      await tx
        .delete(caseLawDecisionSupplements)
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
          ),
        );
    }
    return {
      type: "placed" as const,
      row,
      selection,
      leavesHolder,
      judgment,
    };
  });
  if (placed.type === "erased") {
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "erased", decisionId: placed.decisionId },
    };
  }
  const { row, selection, leavesHolder, judgment } = placed;

  const rawWriteFailed = (error: unknown): ProcessSupplementResult => {
    logger.error("case_law.ingestion.source_raw_write_failed", {
      sourceId,
      caseNumber: document.caseNumber,
      ...errorSystemFields(error),
      "error.detail": wrappedErrorDetail(error),
    });
    captureError(error, { sourceId, step: "processSupplement.raw" });
    return {
      status: PROCESS_DECISION_STATUS.RETRYABLE,
      reason: PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE,
    };
  };

  /**
   * Point the supplement row at the payload its owner now holds. A payload
   * an earlier owner held for it, under a judgment's prefix, is deleted
   * first: a failure after that leaves the row pointing at nothing until the
   * next placement writes it again, never an object no pointer names. A
   * payload under the supplement's own standalone row is that row's, which
   * its absorption removes; one in the source-wide older layout is shared
   * and left to the legacy sweep.
   */
  const pointRawAt = async (
    next: { key: string; contentType: string | null } | null,
  ): Promise<void> => {
    const current = await scopedDb(async (tx) => ({
      pointer: (
        await tx
          .select({ key: caseLawDecisionSupplements.sourceRawS3Key })
          .from(caseLawDecisionSupplements)
          .where(
            and(
              eq(caseLawDecisionSupplements.sourceId, sourceId),
              eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
            ),
          )
          .limit(1)
      ).at(0),
      standaloneId: (
        await tx
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
            ),
          )
          .limit(1)
      ).at(0)?.id,
    }));
    if (current.pointer === undefined) {
      return;
    }
    const previous = current.pointer.key;
    if (previous === (next?.key ?? null)) {
      return;
    }
    if (
      previous !== null &&
      previous.startsWith(
        `${RAW_SOURCE_FAMILY.CASE_LAW}/raw/${sourceId}/documents/`,
      ) &&
      (current.standaloneId === undefined ||
        classifyCaseLawRawKey(previous, {
          sourceId,
          documentId: current.standaloneId,
        }) !== RAW_KEY_OWNERSHIP.OWN)
    ) {
      await deleteRawKeys(
        [previous],
        AbortSignal.timeout(RAW_OBJECT_COPY_TIMEOUT_MS),
      );
    }
    await scopedDb(async (tx) => {
      // audit: skip — background case-law ingestion; public case-law data
      await tx
        .update(caseLawDecisionSupplements)
        .set({
          sourceRawS3Key: next?.key ?? null,
          sourceRawContentType: next?.contentType ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
            previous === null
              ? isNull(caseLawDecisionSupplements.sourceRawS3Key)
              : eq(caseLawDecisionSupplements.sourceRawS3Key, previous),
          ),
        );
    });
  };

  /**
   * Store the payload under the judgment it joins and point the row at it.
   * An unchanged payload the row already records under that judgment writes
   * nothing.
   */
  const judgmentOwnsRaw = async (
    judgmentId: SafeId<"caseLawDecision">,
  ): Promise<ProcessSupplementResult | null> => {
    const stored = (
      await scopedDb((tx) =>
        tx
          .select({
            key: caseLawDecisionSupplements.sourceRawS3Key,
            contentType: caseLawDecisionSupplements.sourceRawContentType,
          })
          .from(caseLawDecisionSupplements)
          .where(
            and(
              eq(caseLawDecisionSupplements.sourceId, sourceId),
              eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
            ),
          )
          .limit(1),
      )
    ).at(0);
    const written = await Result.tryPromise({
      try: async () =>
        await writeOwnedRawPayload({
          result: document,
          sourceId,
          ownerId: judgmentId,
          contentType: rawContentType,
          storedKey: stored?.key ?? null,
          storedContentType: stored?.contentType ?? null,
          window: rawWriteWindow,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(written)) {
      return rawWriteFailed(written.error);
    }
    if (Result.isError(written.value)) {
      return rawWriteFailed(written.value.error);
    }
    const writtenKey = written.value.value;
    if (writtenKey === undefined) {
      return null;
    }
    const pointed = await Result.tryPromise({
      try: async () =>
        await pointRawAt({ key: writtenKey, contentType: rawContentType }),
      catch: (cause) => cause,
    });
    return Result.isError(pointed) ? rawWriteFailed(pointed.error) : null;
  };

  /** Object storage did not answer for the judgment: try the placement again. */
  const judgmentReadFailed = (
    judgmentId: SafeId<"caseLawDecision">,
    error: StoredRawReadError,
  ): ProcessSupplementResult => {
    logger.warn(SUPPLEMENT_JUDGMENT_READ_FAILED, {
      sourceId,
      judgmentId,
      sourceDocumentId,
      ...errorSystemFields(error.cause),
    });
    return {
      status: PROCESS_DECISION_STATUS.RETRYABLE,
      reason: SUPPLEMENT_RETRY_REASON.JUDGMENT_READ,
    };
  };

  /**
   * Take the supplement out of a judgment a correction says it no longer
   * belongs to, then place it again. The former holder is written first, and
   * its write leaves the supplement out (`selectComposableSupplements`); only
   * once its stored document no longer holds the text is the association
   * dropped, so a failure on the way keeps the association and the next
   * observation starts over.
   */
  const leaveFormerHolder = async (
    formerId: SafeId<"caseLawDecision">,
  ): Promise<ProcessSupplementResult> => {
    const rebuiltFormer = await rebuildStoredJudgment({
      judgmentId: formerId,
      scopedDb,
      reparseStoredRaw,
      readStoredRaw,
    });
    if (rebuiltFormer.type === "read-failed") {
      return judgmentReadFailed(formerId, rebuiltFormer.error);
    }
    if (rebuiltFormer.type === "unreadable") {
      logger.warn(SUPPLEMENT_JUDGMENT_UNREADABLE, {
        sourceId,
        judgmentId: formerId,
        sourceDocumentId,
        "error.detail": rebuiltFormer.detail,
      });
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        disposition: {
          type: "standalone",
          reason: SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE,
        },
      };
    }
    const rewritten = await processDecision({
      input: rebuiltFormer.result,
      sourceId,
      scopedDb,
      observedAt,
      observationOrder: await nextObservationOrder(),
      corpus,
      polarityRules,
    });
    if (rewritten.status === PROCESS_DECISION_STATUS.RETRYABLE) {
      return rewritten;
    }
    // The rewrite parks a supplement it leaves out; one still naming the
    // former holder is detached here.
    const detached = await scopedDb(async (tx) => {
      if (
        await detachSupplement(tx, {
          sourceId,
          sourceDocumentId,
          decisionId: formerId,
        })
      ) {
        return true;
      }
      const current = (
        await tx
          .select({ decisionId: caseLawDecisionSupplements.decisionId })
          .from(caseLawDecisionSupplements)
          .where(
            and(
              eq(caseLawDecisionSupplements.sourceId, sourceId),
              eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
            ),
          )
          .limit(1)
      ).at(0);
      return current?.decisionId === null;
    });
    if (!detached) {
      // Moved by a concurrent placement; the next observation settles it.
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
      };
    }
    return await processSupplement({
      supplement,
      sourceId,
      scopedDb,
      observedAt,
      nextObservationOrder,
      reparseStoredRaw,
      readStoredRaw,
      corpus,
      polarityRules,
      absorb,
    });
  };

  if (leavesHolder && row.decisionId !== null) {
    return await leaveFormerHolder(row.decisionId);
  }

  const standalone = async (
    reason: SupplementStandaloneReason,
  ): Promise<ProcessSupplementResult> => {
    // The refresh check reads the publisher's hash, which a row stored before
    // supplements existed shares with this document; only its type differs,
    // and a type is what the check does not read.
    const storedType = (
      await scopedDb((tx) =>
        tx
          .select({ decisionType: caseLawDecisions.decisionType })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
            ),
          )
          .limit(1),
      )
    ).at(0);
    const written = await processDecision({
      input: supplement.document,
      sourceId,
      scopedDb,
      observedAt,
      observationOrder: await nextObservationOrder(),
      refresh:
        storedType !== undefined &&
        storedType.decisionType !== (document.decisionType ?? null)
          ? DECISION_REFRESH.ALWAYS
          : DECISION_REFRESH.WHEN_SOURCE_CHANGED,
      corpus,
      polarityRules,
    });
    if (written.status === PROCESS_DECISION_STATUS.RETRYABLE) {
      return written;
    }
    // Standalone, the supplement is its own row's: that row stored the
    // payload under its prefix, and the supplement names the same object.
    const own = (
      await scopedDb((tx) =>
        tx
          .select({
            key: caseLawDecisions.sourceRawS3Key,
            contentType: caseLawDecisions.sourceRawContentType,
            redactedAt: caseLawDecisions.redactedAt,
          })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
            ),
          )
          .limit(1),
      )
    ).at(0);
    const pointed = await Result.tryPromise({
      try: async () =>
        await pointRawAt(
          own?.key === null || own?.key === undefined || own.redactedAt !== null
            ? null
            : { key: own.key, contentType: own.contentType },
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(pointed)) {
      return rawWriteFailed(pointed.error);
    }
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "standalone", reason },
    };
  };

  if (judgment === null) {
    return await standalone(
      selection.type === "ambiguous"
        ? SUPPLEMENT_STANDALONE_REASON.AMBIGUOUS
        : SUPPLEMENT_STANDALONE_REASON.NO_JUDGMENT,
    );
  }
  /**
   * Take the supplement's standalone row, if any, out of the corpus behind
   * its judgment, then report `disposition`. A row left standing holds the
   * cursor: reporting the placement done would leave a second public copy.
   */
  const absorbed = async (
    disposition: SupplementDisposition,
  ): Promise<ProcessSupplementResult> => {
    const outcome = await absorbComposedSupplementRows({
      scopedDb,
      sourceId,
      judgmentId: judgment.id,
      supplements: [{ kind: supplement.kind, sourceDocumentId }],
      absorb,
    });
    switch (outcome.type) {
      case "absorbed":
        return { status: PROCESS_DECISION_STATUS.COMPLETE, disposition };
      case "incomplete":
        return {
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          reason: SUPPLEMENT_RETRY_REASON.ABSORB,
        };
      default: {
        outcome satisfies never;
        return panic(`Unhandled absorption: ${JSON.stringify(outcome)}`);
      }
    }
  };

  if (judgment.redacted) {
    return await absorbed({ type: "withheld", judgmentId: judgment.id });
  }

  const merged = async (): Promise<ProcessSupplementResult> =>
    (await judgmentOwnsRaw(judgment.id)) ??
    (await absorbed({ type: "merged", judgmentId: judgment.id }));

  if (
    row.decisionId === judgment.id &&
    row.mergedSourceHash === row.sourceHash
  ) {
    return await merged();
  }

  const rebuilt = await rebuildStoredJudgment({
    judgmentId: judgment.id,
    scopedDb,
    reparseStoredRaw,
    readStoredRaw,
  });
  if (rebuilt.type === "read-failed") {
    return judgmentReadFailed(judgment.id, rebuilt.error);
  }
  if (rebuilt.type === "unreadable") {
    logger.warn(SUPPLEMENT_JUDGMENT_UNREADABLE, {
      sourceId,
      judgmentId: judgment.id,
      sourceDocumentId,
      "error.detail": rebuilt.detail,
    });
    if (row.decisionId === judgment.id) {
      // The judgment still publishes an earlier version; a standalone row
      // would be a second public copy of the same reasons.
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        disposition: {
          type: "standalone",
          reason: SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE,
        },
      };
    }
    return await standalone(SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE);
  }
  const written = await processDecision({
    input: rebuilt.result,
    sourceId,
    scopedDb,
    observedAt,
    observationOrder: await nextObservationOrder(),
    corpus,
    polarityRules,
  });
  if (written.status === PROCESS_DECISION_STATUS.RETRYABLE) {
    return written;
  }

  const after = (
    await scopedDb((tx) =>
      tx
        .select({
          decisionId: caseLawDecisionSupplements.decisionId,
          mergedSourceHash: caseLawDecisionSupplements.mergedSourceHash,
          sourceHash: caseLawDecisionSupplements.sourceHash,
        })
        .from(caseLawDecisionSupplements)
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
          ),
        )
        .limit(1),
    )
  ).at(0);
  if (
    after?.decisionId === judgment.id &&
    after.mergedSourceHash === after.sourceHash
  ) {
    // The judgment's write absorbed the row already, or reported that it
    // could not; asking again settles which.
    return await merged();
  }
  return await standalone(
    SUPPLEMENT_STANDALONE_REASON.JUDGMENT_WITHOUT_DOCUMENT,
  );
};
