import { Result } from "better-result";

import { mapWithConcurrency } from "@stll/concurrency";

import type { ScopedDb } from "@/api/db/safe-db";
import { wrappedErrorDetail } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import {
  absorbStandaloneSupplementRow,
  rehomeSupplementRaw,
} from "@/api/handlers/case-law/ingestion/supplement-absorption";
import type { StoredSupplement } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";

/** Emitted when a supplement's standalone row could not be absorbed. */
export const SUPPLEMENT_ABSORB_FAILED =
  "case_law.ingestion.supplement_absorb_failed";

type AbsorbComposedSupplementRowsOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  judgmentId: SafeId<"caseLawDecision">;
  supplements: readonly Pick<StoredSupplement, "kind" | "sourceDocumentId">[];
  /** Test seam; production absorbs through the corpus stores. */
  absorb?: typeof absorbStandaloneSupplementRow;
};

type AbsorbComposedSupplementRowsOutcome =
  | { type: "absorbed" }
  /** Rows still standing beside the judgment; see the function comment. */
  | { type: "incomplete"; sourceDocumentIds: string[] };

/**
 * Take the standalone rows of supplements this judgment now holds out of the
 * corpus. Runs after the judgment's write committed, since the withdrawal
 * reaches object storage. A row that stays standing is reported, not thrown:
 * the judgment is already right. The caller decides whether to hold its
 * cursor; either way the reconciliation reads a merged supplement whose row
 * still stands as not held, so it is listed and placed again.
 */
export const absorbComposedSupplementRows = async ({
  scopedDb,
  sourceId,
  judgmentId,
  supplements,
  absorb = absorbStandaloneSupplementRow,
}: AbsorbComposedSupplementRowsOptions): Promise<AbsorbComposedSupplementRowsOutcome> => {
  // One at a time: each absorption takes the citation graph lock.
  const standing = await mapWithConcurrency({
    items: supplements,
    limit: 1,
    operation: async ({ kind, sourceDocumentId }) => {
      // The payload moves under the judgment before the row's copy goes.
      const rehomed = await Result.tryPromise({
        try: async () =>
          await rehomeSupplementRaw({
            scopedDb,
            sourceId,
            sourceDocumentId,
            judgmentId,
          }),
        catch: (cause) => cause,
      });
      const rehomeError = ((): unknown => {
        if (Result.isError(rehomed)) {
          return rehomed.error;
        }
        return Result.isError(rehomed.value) ? rehomed.value.error : null;
      })();
      if (rehomeError !== null) {
        logger.error(SUPPLEMENT_ABSORB_FAILED, {
          sourceId,
          judgmentId,
          sourceDocumentId,
          ...errorSystemFields(rehomeError),
          "error.detail": wrappedErrorDetail(rehomeError),
        });
        return [sourceDocumentId];
      }
      const absorbed = await absorb({
        scopedDb,
        sourceId,
        kind,
        sourceDocumentId,
        judgmentId,
      });
      if (Result.isError(absorbed)) {
        logger.error(SUPPLEMENT_ABSORB_FAILED, {
          sourceId,
          judgmentId,
          sourceDocumentId,
          ...errorSystemFields(absorbed.error),
          "error.detail": wrappedErrorDetail(absorbed.error),
        });
        captureError(absorbed.error, {
          sourceId,
          step: "absorbComposedSupplementRows",
        });
        return [sourceDocumentId];
      }
      if (absorbed.value.type === "withdraw-incomplete") {
        logger.error(SUPPLEMENT_ABSORB_FAILED, {
          sourceId,
          judgmentId,
          sourceDocumentId,
          "error.detail":
            "a corpus object still holds the standalone row's document",
        });
        return [sourceDocumentId];
      }
      if (absorbed.value.type === "raw-incomplete") {
        logger.error(SUPPLEMENT_ABSORB_FAILED, {
          sourceId,
          judgmentId,
          sourceDocumentId,
          ...errorSystemFields(absorbed.value.error),
          "error.detail":
            "a raw object still holds the standalone row's payload",
        });
        return [sourceDocumentId];
      }
      return [];
    },
  });
  const sourceDocumentIds = standing.flat();
  return sourceDocumentIds.length === 0
    ? { type: "absorbed" }
    : { type: "incomplete", sourceDocumentIds };
};
