import { classifyFailure } from "@stll/errors";

import { DOCUMENT_FETCH_BUDGET_MS } from "@/api/lib/legal-search/sk-document-backfill";

/**
 * Grades the expiry of a document fetch's wall-clock budget. A publisher too
 * slow for the budget is the source's state rather than a fault here: the
 * work stays queued and the next pass retries it. The fetch rejects with the
 * budget's own abort reason, so that reason carries the grade, and a failure
 * the budget did not cause keeps its own.
 */
export const gradedDocumentFetchBudget = (budget: AbortSignal): AbortSignal => {
  budget.addEventListener(
    "abort",
    () => {
      const reason: unknown = budget.reason;
      if (typeof reason === "object" && reason !== null) {
        classifyFailure(reason, "upstream_unavailable");
      }
    },
    { once: true },
  );
  return budget;
};

/**
 * Starts one document fetch's wall-clock budget, graded on expiry. Every
 * caller that fetches a deferred document (the read-through path and the
 * background drain) starts its budget here, so an expiry is graded the same
 * way whichever of them ran out of time.
 */
export const startDocumentFetchBudget = (
  budgetMs: number = DOCUMENT_FETCH_BUDGET_MS,
): AbortSignal => gradedDocumentFetchBudget(AbortSignal.timeout(budgetMs));
