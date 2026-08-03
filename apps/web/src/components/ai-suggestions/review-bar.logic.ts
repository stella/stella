import type {
  ReviewSuggestion,
  ReviewSuggestionStatus,
} from "@/components/ai-suggestions/review-store";

export type ReviewBarAction = "resolve" | "revert" | "busy";

export const getReviewBarAction = (
  status: ReviewSuggestionStatus,
): ReviewBarAction => {
  switch (status) {
    case "pending":
      return "resolve";
    case "applying":
      return "busy";
    case "accepted":
    case "rejected":
    case "skipped":
      return "revert";
    default:
      status satisfies never;
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
