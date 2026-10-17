import { useSyncExternalStore } from "react";

import type * as v from "valibot";

import type { DocumentTranslationTargetLanguageCode } from "@stll/api-contract/document-translation";

import type { PersistedStateDefinition } from "@/hooks/persisted-storage-adapter";
import {
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

const noopSubscribe = () => () => undefined;
const noStoredTarget = () => null;

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
export const useLastTranslationTarget = <
  TSchema extends v.BaseSchema<
    unknown,
    DocumentTranslationTargetLanguageCode | null,
    v.BaseIssue<unknown>
  >,
>(
  entry: PersistedStateDefinition<TSchema, Record<never, never>>,
): LastTranslationTarget => {
  const lastTarget = useSyncExternalStore(
    noopSubscribe,
    () => readPersistedState(entry, {}),
    noStoredTarget,
  );

  return {
    lastTarget,
    rememberTarget: (target) => {
      writePersistedState(entry, {}, target);
    },
  };
};
