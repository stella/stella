import { useState, useSyncExternalStore } from "react";

import {
  parseReviewStartMode,
  REVIEW_START_MODE,
  reviewStartModeStorageKey,
} from "@/components/ai-suggestions/document-review-basis.logic";
import type { ReviewStartMode } from "@/components/ai-suggestions/document-review-basis.logic";

const noopSubscribe = () => () => undefined;

const readStoredMode = (key: string): ReviewStartMode => {
  try {
    return parseReviewStartMode(localStorage.getItem(key));
  } catch {
    // Storage can be blocked entirely (private browsing, a locked-down
    // profile); the default is what an unanswered question reads as.
    return REVIEW_START_MODE.immediate;
  }
};

/**
 * Whether this document's review starts on the proposal or stops to have it
 * confirmed, remembered across sessions.
 *
 * Read once per mount rather than subscribed: the launcher is the only writer,
 * and its own toggle is the override held in state — a storage subscription
 * would only re-render the surface that just wrote the value.
 */
export const useReviewStartMode = (entityId: string, fileFieldId: string) => {
  const key = reviewStartModeStorageKey(entityId, fileFieldId);
  const storedMode = useSyncExternalStore(
    noopSubscribe,
    () => readStoredMode(key),
    () => REVIEW_START_MODE.immediate,
  );
  const [override, setOverride] = useState<ReviewStartMode | null>(null);

  const setMode = (mode: ReviewStartMode) => {
    setOverride(mode);
    try {
      localStorage.setItem(key, mode);
    } catch {
      // Best-effort: a blocked or full store costs the memory of the choice,
      // never the choice itself.
    }
  };

  return { mode: override ?? storedMode, setMode };
};
