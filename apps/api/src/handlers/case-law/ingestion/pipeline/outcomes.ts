import { panic } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { errorSystemFields } from "@/api/lib/errors/utils";
import type { CorpusPackBatchOutcome } from "@/api/lib/legal-search/corpus-pack-batch";
import { logger } from "@/api/lib/observability/logger";
import { pgErrorFields } from "@/api/lib/pg-error";

/**
 * Bound the outer message and the cause separately: a wrapped driver
 * error carries the full failed query in its outer message, which would
 * otherwise consume the whole budget and truncate the cause — the part
 * that says why the write failed.
 */
export const wrappedErrorDetail = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error).slice(0, 512);
  }
  const outer = error.message.slice(0, 200);
  return error.cause instanceof Error
    ? `${outer} (cause: ${error.cause.message.slice(0, 300)})`
    : outer;
};

export const PROCESS_DECISION_STATUS = {
  COMPLETE: "complete",
  RETRYABLE: "retryable",
} as const;

export const PROCESS_DECISION_RETRY_REASON = {
  CONTENTION: "contention",
  CORPUS_WRITE: "corpus-write",
  SOURCE_RAW_WRITE: "source-raw-write",
} as const;

/** Why a supplement's placement is retried beyond its writes' own reasons. */
export const SUPPLEMENT_RETRY_REASON = {
  /** Its standalone row still stands beside its judgment. */
  ABSORB: "supplement-absorb",
  /** Its judgment's stored payload could not be read this time. */
  JUDGMENT_READ: "supplement-judgment-read",
} as const;

export type ProcessResult =
  | {
      status: typeof PROCESS_DECISION_STATUS.COMPLETE;
      inserted: boolean;
      searchVectorFailed: boolean;
    }
  | {
      status: typeof PROCESS_DECISION_STATUS.RETRYABLE;
      inserted: boolean;
      reason: (typeof PROCESS_DECISION_RETRY_REASON)[keyof typeof PROCESS_DECISION_RETRY_REASON];
    };

type CorpusOutcomeContext = {
  decisionId: SafeId<"caseLawDecision">;
  /** Present where the caller still holds the adapter's own result. */
  caseNumber?: string;
  country?: string;
};

/**
 * What one decision's share of a pack write means for its own processing.
 *
 * A decision that lost its reservation or its row CAS holds the cursor: the
 * page is retried and the decision joins the next batch's pack. A failed
 * pack write holds it too, and is logged here because the halt reason
 * carries only a count.
 */
export const processResultForCorpusOutcome = (
  outcome: CorpusPackBatchOutcome | undefined,
  { decisionId, caseNumber, country }: CorpusOutcomeContext,
): ProcessResult => {
  switch (outcome?.type) {
    case undefined:
      // Asked for after its payloads were queued, so an absent outcome is a
      // settlement that did not happen, not one that was not needed.
      logger.error("case_law.ingestion.corpus_settlement_missing", {
        decisionId,
        caseNumber: caseNumber ?? "",
        country: country ?? "",
      });
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: true,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      };
    case "settled":
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: true,
        searchVectorFailed: false,
      };
    case "redacted-or-missing":
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: false,
        searchVectorFailed: false,
      };
    case "busy":
    case "retry":
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: false,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      };
    case "failed": {
      logger.error("case_law.ingestion.corpus_write_failed", {
        decisionId,
        caseNumber: caseNumber ?? "",
        country: country ?? "",
        ...errorSystemFields(outcome.error),
        ...pgErrorFields(outcome.error),
        "error.detail": wrappedErrorDetail(outcome.error),
      });
      captureError(outcome.error, {
        decisionId,
        step: "processDecision.corpusWrite",
      });
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: true,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      };
    }
    default:
      outcome satisfies never;
      return panic(`Unhandled corpus batch outcome: ${String(outcome)}`);
  }
};
