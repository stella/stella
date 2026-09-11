import { panic } from "better-result";

import {
  type DocumentTranslationRunErrorCode,
  type DocumentTranslationTargetLanguageCode,
} from "@stll/api-contract/document-translation";

import {
  defaultTargetLanguage,
  isDocumentTranslationTargetCode,
} from "@/components/document-language-picker.logic";
import type { TranslationKey } from "@/i18n/types";

const DOCUMENT_TRANSLATION_RUN_FAILURE_KEYS = {
  document_changed: "translate.dialog.runFailed",
  document_unresolved: "translate.dialog.runFailed",
  format_validation_failed: "translate.dialog.runFailed",
  internal: "translate.dialog.runFailed",
  provider_unavailable: "translate.dialog.providerUnavailable",
  translation_failed: "translate.dialog.runFailed",
  unsupported_format: "translate.dialog.runFailed",
  unsupported_review_markup: "translate.dialog.runFailed",
} as const satisfies Record<DocumentTranslationRunErrorCode, TranslationKey>;

type DocumentTranslationRunFailureKey =
  (typeof DOCUMENT_TRANSLATION_RUN_FAILURE_KEYS)[DocumentTranslationRunErrorCode];

/** Maps the persisted safe error code, never an upstream provider message. */
export const documentTranslationRunFailureKey = (
  errorCode: DocumentTranslationRunErrorCode | null,
): DocumentTranslationRunFailureKey =>
  errorCode === null
    ? "translate.dialog.runFailed"
    : DOCUMENT_TRANSLATION_RUN_FAILURE_KEYS[errorCode];

type CanStartDocumentTranslationOptions = {
  canUseDeepL: boolean;
  isDeepL: boolean;
  isLoadingRun: boolean;
  isRunning: boolean;
  isStarting: boolean;
  hasCommentPolicy: boolean;
  hasPreparedAiVersion: boolean;
  requiresCommentPolicy: boolean;
};

export type TranslationChoice =
  | "bilingual:ai"
  | "translated:ai"
  | "translated:deepl";

/**
 * stella AI is what the dialog opens on. DeepL is offered last and is never
 * the default.
 */
export const DEFAULT_TRANSLATION_CHOICE: TranslationChoice = "translated:ai";

type CanTranslateDocumentOptions = {
  canUseDeepL: boolean;
  isDocx: boolean;
};

export const canTranslateDocument = ({
  canUseDeepL,
  isDocx,
}: CanTranslateDocumentOptions): boolean => isDocx || canUseDeepL;

type ActiveTranslationChoiceOptions = {
  selected: TranslationChoice;
  canUseDeepL: boolean;
  isDocx: boolean;
};

/**
 * The choice the dialog acts on, which is never one of the disabled cards: a
 * removed DeepL key must not leave a stale DeepL selection standing, and a
 * file stella AI cannot open has only DeepL to offer.
 */
export const activeTranslationChoice = ({
  selected,
  canUseDeepL,
  isDocx,
}: ActiveTranslationChoiceOptions): TranslationChoice => {
  switch (selected) {
    case "translated:deepl":
      return canUseDeepL ? selected : DEFAULT_TRANSLATION_CHOICE;
    case "translated:ai":
    case "bilingual:ai":
      return isDocx || !canUseDeepL ? selected : "translated:deepl";
    default: {
      selected satisfies never;
      return panic(`Unhandled selected: ${String(selected)}`);
    }
  }
};

/** One remembered choice per browser; not per document, not per matter. */
export const LAST_TRANSLATION_TARGET_STORAGE_KEY =
  "document_translation_last_target";

export const parseLastTranslationTarget = (
  raw: string | null,
): DocumentTranslationTargetLanguageCode | null =>
  raw !== null && isDocumentTranslationTargetCode(raw) ? raw : null;

type DefaultDocumentTranslationTargetOptions = {
  /** This browser's last successful choice, or null before the first run. */
  lastUsedTarget: DocumentTranslationTargetLanguageCode | null;
  supportedTargets: readonly DocumentTranslationTargetLanguageCode[];
  uiLocale: string;
};

/**
 * Which language the dialog proposes translating into.
 *
 * A deliberate choice from this browser is stronger than the UI locale. The
 * translation engine, not this default, determines the source language.
 */
export const defaultDocumentTranslationTarget = ({
  lastUsedTarget,
  supportedTargets,
  uiLocale,
}: DefaultDocumentTranslationTargetOptions): DocumentTranslationTargetLanguageCode => {
  const offered = new Set<string>(supportedTargets);
  if (lastUsedTarget !== null && offered.has(lastUsedTarget)) {
    return lastUsedTarget;
  }
  const fromLocale = defaultTargetLanguage(uiLocale);
  if (offered.has(fromLocale)) {
    return fromLocale;
  }
  return (
    supportedTargets.at(0) ?? panic("No translation target is available")
  );
};

export type DocumentTranslationCommentPolicy =
  | "original"
  | "original-and-translated"
  | "translated";

export type DocumentTranslationCommentPolicyState =
  | { type: "unchecked" }
  | {
      type: "required";
      entityId: string;
      fieldId: string;
      policy: DocumentTranslationCommentPolicy | null;
    };

type CommentPolicyStateForSourceOptions = {
  state: DocumentTranslationCommentPolicyState;
  entityId: string;
  fieldId: string;
};

const UNCHECKED_COMMENT_POLICY_STATE = { type: "unchecked" } as const;

export const commentPolicyStateForSource = ({
  state,
  entityId,
  fieldId,
}: CommentPolicyStateForSourceOptions): DocumentTranslationCommentPolicyState => {
  switch (state.type) {
    case "unchecked":
      return state;
    case "required":
      return state.entityId === entityId && state.fieldId === fieldId
        ? state
        : UNCHECKED_COMMENT_POLICY_STATE;
    default: {
      state satisfies never;
      return panic(`Unhandled state: ${String(state)}`);
    }
  }
};

export const canStartDocumentTranslation = ({
  canUseDeepL,
  isDeepL,
  isLoadingRun,
  isRunning,
  isStarting,
  hasCommentPolicy,
  hasPreparedAiVersion,
  requiresCommentPolicy,
}: CanStartDocumentTranslationOptions): boolean =>
  !isStarting &&
  !isLoadingRun &&
  (!isDeepL || canUseDeepL) &&
  (isDeepL || hasPreparedAiVersion) &&
  (!requiresCommentPolicy || hasCommentPolicy) &&
  !isRunning;

type OpenDocumentTranslationOutputOptions = {
  closeDialog: () => void;
  navigate: () => Promise<unknown>;
  prepareDestination: () => Promise<unknown>;
};

/** Keep route pending UI out from behind the completion dialog. */
export const openDocumentTranslationOutput = async ({
  closeDialog,
  navigate,
  prepareDestination,
}: OpenDocumentTranslationOutputOptions) => {
  await prepareDestination();
  closeDialog();
  await navigate();
};
