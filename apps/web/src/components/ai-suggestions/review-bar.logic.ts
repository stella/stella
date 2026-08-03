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
 * Keep the focus id valid across store hydration and session replacement.
 * A new review starts at its first pending suggestion; an already-resolved
 * session still has a deterministic first item for inspection.
 */
export const getReviewBarFocusTarget = (
  suggestions: readonly ReviewSuggestion[],
  focusedId: string | null,
): string | null => {
  if (focusedId !== null && suggestions.some((item) => item.id === focusedId)) {
    return null;
  }
  return (
    (suggestions.find((item) => item.status === "pending") ?? suggestions.at(0))
      ?.id ?? null
  );
};

/**
 * The counter and navigation deliberately use the full session. Resolved
 * suggestions stay addressable so the reviewer can inspect or revert them;
 * pending/applying state only controls each item's available action.
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
  return {
    activeIndex,
    current: activeIndex + 1,
    total: suggestions.length,
  };
};
