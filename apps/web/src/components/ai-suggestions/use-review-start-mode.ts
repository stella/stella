import { useState, useSyncExternalStore } from "react";

import {
  parseReviewStartMode,
  REVIEW_START_MODE,
  reviewStartModeStorageKey,
} from "@/components/ai-suggestions/document-review-basis.logic";
import type { ReviewStartMode } from "@/components/ai-suggestions/document-review-basis.logic";
import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  onStorageOwnerChange,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";

const readStoredMode = (key: string): ReviewStartMode =>
  parseReviewStartMode(browserStateStorage("local").getItem(key));

/**
 * Whether this document's review starts on the proposal or stops to have it
 * confirmed, remembered across sessions.
 *
 * Read on mount and account changes. The launcher keeps its own toggle in
 * state, scoped to the account key that made the choice.
 */
export const useReviewStartMode = (entityId: string, fileFieldId: string) => {
  const baseKey = reviewStartModeStorageKey(entityId, fileFieldId);
  const key = useSyncExternalStore(
    onStorageOwnerChange,
    () => userStorageKey(baseKey),
    () => userStorageKey(baseKey, { kind: "visitor" }),
  );
  const storedMode = useSyncExternalStore(
    onStorageOwnerChange,
    () => readStoredMode(key),
    () => REVIEW_START_MODE.immediate,
  );
  const [override, setOverride] = useState<{
    key: string;
    mode: ReviewStartMode | null;
  }>({ key, mode: null });
  if (override.key !== key) {
    setOverride({ key, mode: null });
  }

  const setMode = (mode: ReviewStartMode) => {
    setOverride({ key, mode });
    browserStateStorage("local").setItem(key, mode);
  };

  return {
    mode: override.key === key ? (override.mode ?? storedMode) : storedMode,
    setMode,
  };
};
