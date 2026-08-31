import { useSyncExternalStore } from "react";

import type { DocumentTranslationTargetLanguageCode } from "@stll/api-contract/document-translation";

import {
  LAST_TRANSLATION_TARGET_STORAGE_KEY,
  parseLastTranslationTarget,
} from "@/components/translate-document-dialog.logic";

const noopSubscribe = () => () => undefined;
const noStoredTarget = () => null;

const readStoredTarget = (): DocumentTranslationTargetLanguageCode | null => {
  try {
    return parseLastTranslationTarget(
      localStorage.getItem(LAST_TRANSLATION_TARGET_STORAGE_KEY),
    );
  } catch {
    // Storage can be blocked entirely (private browsing, a locked-down
    // profile); no remembered choice is the same as never having made one.
    return null;
  }
};

type LastTranslationTarget = {
  lastTarget: DocumentTranslationTargetLanguageCode | null;
  rememberTarget: (target: DocumentTranslationTargetLanguageCode) => void;
};

/**
 * The language this browser last translated into, used only as a fallback
 * proposal behind what the matter is written in.
 *
 * Read once per mount rather than subscribed: the translate dialog is the only
 * writer, and it already knows what it wrote.
 */
export const useLastTranslationTarget = (): LastTranslationTarget => {
  const lastTarget = useSyncExternalStore(
    noopSubscribe,
    readStoredTarget,
    noStoredTarget,
  );

  return {
    lastTarget,
    rememberTarget: (target) => {
      try {
        localStorage.setItem(LAST_TRANSLATION_TARGET_STORAGE_KEY, target);
      } catch {
        // Best-effort: a blocked or full store costs the memory of the choice,
        // never the choice itself.
      }
    },
  };
};
