import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";

export type ReviewBarAction = "resolve" | "revert" | "busy" | "resolved";

export const canRevertReviewSuggestion = (
  suggestion: ReviewSuggestion,
): boolean => {
  switch (suggestion.status) {
    case "accepted":
      return suggestion.revisionIds !== null || suggestion.undoHandle !== null;
    case "rejected":
    case "skipped":
      return true;
    case "applying":
    case "pending":
      return false;
    default:
      suggestion.status satisfies never;
      return false;
  }
};

export const getReviewBarAction = (
  suggestion: ReviewSuggestion,
): ReviewBarAction => {
  switch (suggestion.status) {
    case "pending":
      return "resolve";
    case "applying":
      return "busy";
    case "rejected":
    case "skipped":
      return "revert";
    case "accepted":
      return canRevertReviewSuggestion(suggestion) ? "revert" : "resolved";
    default:
      suggestion.status satisfies never;
      return "busy";
  }
};

type ReviewBarPosition = {
  activeIndex: number;
  current: number;
  total: number;
};

/**
 * Review progress is position within the original session, not position in a
 * shrinking pending queue. Resolved items stay addressable so the reviewer can
 * navigate back and revert any individual decision.
 */
export const getReviewBarPosition = (
  suggestions: readonly ReviewSuggestion[],
  focusedId: string | null,
): ReviewBarPosition => {
  const total = suggestions.length;
  if (total === 0) {
    return { activeIndex: 0, current: 0, total: 0 };
  }
  const focusedIndex = suggestions.findIndex((item) => item.id === focusedId);
  const activeIndex = Math.max(focusedIndex, 0);
  return { activeIndex, current: activeIndex + 1, total };
};
