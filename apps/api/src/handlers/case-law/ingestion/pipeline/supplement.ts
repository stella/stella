import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { caseLawDecisionSupplements } from "@/api/db/schema";
import { processStoredDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { CASE_LAW_CORPUS_DEPENDENCIES } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import type { SourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { rebuildStoredJudgment } from "@/api/handlers/case-law/ingestion/pipeline/stored-judgment";
import { DECISION_SUPPLEMENT_DOCUMENT_ROLE } from "@/api/handlers/case-law/ingestion/pipeline/supplement-document-role";
import {
  absorbSupplementIntoJudgment,
  judgmentOwnsSupplementRaw,
  keepSupplementStandalone,
  placeSupplementTx,
  supplementContent,
  supplementJudgmentReadFailed,
} from "@/api/handlers/case-law/ingestion/pipeline/supplement-placement";
import type { SupplementPlacement } from "@/api/handlers/case-law/ingestion/pipeline/supplement-placement";
import {
  SUPPLEMENT_JUDGMENT_UNREADABLE,
  SUPPLEMENT_REMOVED_WHILE_LEAVING,
  SUPPLEMENT_STANDALONE_REASON,
} from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";
import type {
  ProcessSupplementOptions,
  ProcessSupplementResult,
} from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";
import { absorbStandaloneSupplementRow } from "@/api/handlers/case-law/ingestion/supplement-absorption";
import { detachSupplement } from "@/api/handlers/case-law/ingestion/supplement-composition";
import type { SupplementTargetKey } from "@/api/handlers/case-law/ingestion/supplement-composition";
import type { SafeId } from "@/api/lib/branded-types";
import { assertDocketKeyedSupplementAllowed } from "@/api/lib/legal-search/decision-language-identity";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";

/**
 * What became of the supplement row once its former holder was written:
 * detached from it, moved to another judgment by a concurrent placement,
 * or deleted.
 */
type FormerHolderLeft = "detached" | "moved" | "removed";

/**
 * Take the supplement out of a judgment a correction says it no longer
 * belongs to, then place it again. The former holder is written first, and
 * its write leaves the supplement out (`selectComposableSupplements`); only
 * once its stored document no longer holds the text is the association
 * dropped, so a failure on the way keeps the association and the next
 * observation starts over.
 */
const leaveFormerHolder = async (
  placement: SupplementPlacement,
  formerId: SafeId<"caseLawDecision">,
): Promise<Result<ProcessSupplementResult, unknown>> => {
  const {
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
    sourceDocumentId,
  } = placement;
  const rebuiltFormer = await rebuildStoredJudgment({
    judgmentId: formerId,
    scopedDb,
    reparseStoredRaw,
    readStoredRaw,
  });
  if (rebuiltFormer.type === "read-failed") {
    return Result.ok(
      supplementJudgmentReadFailed(placement, formerId, rebuiltFormer.error),
    );
  }
  if (rebuiltFormer.type === "unreadable") {
    logger.warn(SUPPLEMENT_JUDGMENT_UNREADABLE, {
      sourceId,
      judgmentId: formerId,
      sourceDocumentId,
      "error.detail": rebuiltFormer.detail,
    });
    return Result.ok({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: {
        type: "standalone",
        reason: SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE,
      },
    });
  }
  const rewritten = await processStoredDecision(
    {
      input: rebuiltFormer.result,
      decisionId: formerId,
      sourceRawS3Key: rebuiltFormer.sourceRawS3Key,
      sourceId,
      scopedDb,
      observedAt,
      observationOrder: await nextObservationOrder(),
      corpus,
      polarityRules,
    },
    placement.resolveSourceContract,
  );
  if (rewritten.isErr()) {
    return rewritten;
  }
  if (rewritten.value.status === PROCESS_DECISION_STATUS.RETRYABLE) {
    return Result.ok(rewritten.value);
  }
  // The rewrite parks a supplement it leaves out; one still naming the
  // former holder is detached here.
  const left = await scopedDb(async (tx): Promise<FormerHolderLeft> => {
    if (
      await detachSupplement(tx, {
        sourceId,
        sourceDocumentId,
        decisionId: formerId,
      })
    ) {
      return "detached";
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
    if (current === undefined) {
      return "removed";
    }
    return current.decisionId === null ? "detached" : "moved";
  });
  switch (left) {
    case "detached":
      break;
    case "moved":
      // Moved by a concurrent placement; the next observation settles it.
      return Result.ok({
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
      });
    case "removed":
      // Only an erasure or a takedown deletes a supplement row (see
      // SUPPLEMENT_ROW_DELETERS). Placing it again here would bring back
      // what it removed, and retrying would only wait for the next
      // observation, which places it from the start where the erasure
      // checks run. So the step ends here.
      logger.warn(SUPPLEMENT_REMOVED_WHILE_LEAVING, {
        sourceId,
        judgmentId: formerId,
        sourceDocumentId,
      });
      return Result.ok({
        status: PROCESS_DECISION_STATUS.COMPLETE,
        disposition: { type: "removed", formerJudgmentId: formerId },
      });
    default:
      left satisfies never;
      return panic("Unhandled former holder outcome");
  }
  return await processSupplement(
    {
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
    },
    placement.resolveSourceContract,
  );
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
export const processSupplement = async (
  {
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
  }: ProcessSupplementOptions,
  resolveSourceContract: SourceContractResolver = createSourceContractResolver(
    scopedDb,
  ),
): Promise<Result<ProcessSupplementResult, unknown>> => {
  const { metadataUrlSchema } = await resolveSourceContract(sourceId);
  const { sourceDocumentId } = supplement.document;
  const expectedRole = DECISION_SUPPLEMENT_DOCUMENT_ROLE[supplement.kind];
  if (
    supplement.document.documentRole !== undefined &&
    supplement.document.documentRole !== expectedRole
  ) {
    return panic("Supplement kind contradicts the publisher document role");
  }
  // The internal supplement kind does not establish a publisher role when
  // the adapter could not classify every component of the source enum.
  const sanitized = sanitizeResult(supplement.document, metadataUrlSchema);
  if (sanitized.isErr()) {
    return sanitized;
  }
  const document = sanitized.value;
  assertDocketKeyedSupplementAllowed(document.country);
  const key: SupplementTargetKey = {
    sourceId,
    court: document.court,
    caseNumber: document.caseNumber,
    language: document.language,
  };

  // The publisher's response is stored under the decision that owns the
  // supplement: its judgment once it joins one, its own standalone row until
  // then. Which one is known only once it is placed, so the row's pointer is
  // written by the placement (`pointSupplementRawAt`), and an erasure of
  // either owner reaches it by that owner's prefix.
  const rawContentType = document.sourceRawContentType ?? "text/plain";
  // Opened before the read below that proves the judgment live, as a
  // decision's own write opens it; see `openRawSourceWriteWindow`.
  const rawWriteWindow = openRawSourceWriteWindow();

  const content = supplementContent(supplement, document);
  const placed = await scopedDb(
    async (tx) =>
      await placeSupplementTx(tx, {
        key,
        sourceId,
        sourceDocumentId,
        supplement,
        observedAt,
        content,
      }),
  );
  if (placed.type === "erased") {
    return Result.ok({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "erased", decisionId: placed.decisionId },
    });
  }
  const { row, selection, leavesHolder, judgment } = placed;

  const placement: SupplementPlacement = {
    metadataUrlSchema,
    resolveSourceContract,
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
    sourceDocumentId,
    document,
    rawContentType,
    rawWriteWindow,
  };

  if (leavesHolder && row.decisionId !== null) {
    return await leaveFormerHolder(placement, row.decisionId);
  }

  if (judgment === null) {
    return await keepSupplementStandalone(
      placement,
      selection.type === "ambiguous"
        ? SUPPLEMENT_STANDALONE_REASON.AMBIGUOUS
        : SUPPLEMENT_STANDALONE_REASON.NO_JUDGMENT,
    );
  }

  if (judgment.redacted) {
    return Result.ok(
      await absorbSupplementIntoJudgment(placement, judgment.id, {
        type: "withheld",
        judgmentId: judgment.id,
      }),
    );
  }

  const merged = async (): Promise<ProcessSupplementResult> =>
    (await judgmentOwnsSupplementRaw(placement, judgment.id)) ??
    (await absorbSupplementIntoJudgment(placement, judgment.id, {
      type: "merged",
      judgmentId: judgment.id,
    }));

  if (
    row.decisionId === judgment.id &&
    row.mergedSourceHash === row.sourceHash
  ) {
    return Result.ok(await merged());
  }

  const rebuilt = await rebuildStoredJudgment({
    judgmentId: judgment.id,
    scopedDb,
    reparseStoredRaw,
    readStoredRaw,
  });
  if (rebuilt.type === "read-failed") {
    return Result.ok(
      supplementJudgmentReadFailed(placement, judgment.id, rebuilt.error),
    );
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
      return Result.ok({
        status: PROCESS_DECISION_STATUS.COMPLETE,
        disposition: {
          type: "standalone",
          reason: SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE,
        },
      });
    }
    return await keepSupplementStandalone(
      placement,
      SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE,
    );
  }
  const written = await processStoredDecision(
    {
      input: rebuilt.result,
      decisionId: judgment.id,
      sourceRawS3Key: rebuilt.sourceRawS3Key,
      sourceId,
      scopedDb,
      observedAt,
      observationOrder: await nextObservationOrder(),
      corpus,
      polarityRules,
    },
    resolveSourceContract,
  );
  if (written.isErr()) {
    return written;
  }
  if (written.value.status === PROCESS_DECISION_STATUS.RETRYABLE) {
    return Result.ok(written.value);
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
    return Result.ok(await merged());
  }
  return await keepSupplementStandalone(
    placement,
    SUPPLEMENT_STANDALONE_REASON.JUDGMENT_WITHOUT_DOCUMENT,
  );
};
