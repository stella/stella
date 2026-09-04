import { panic } from "better-result";

import {
  documentTranslationSourceForTarget,
  type DocumentTranslationRunErrorCode,
  type DocumentTranslationSourceLanguageCode,
  type DocumentTranslationSourceLanguageDetection,
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
  requiresCommentPolicy: boolean;
  hasPreparedAiSource: boolean;
  hasResolvedAiSource: boolean;
  sameLanguage: boolean;
};

export type DocumentTranslationSourceSelection =
  | { type: "automatic" }
  | { type: "manual"; language: DocumentTranslationSourceLanguageCode };

type ResolvedDocumentTranslationSourceOptions = {
  selection: DocumentTranslationSourceSelection;
  detection: DocumentTranslationSourceLanguageDetection | null;
};

export const resolvedDocumentTranslationSource = ({
  selection,
  detection,
}: ResolvedDocumentTranslationSourceOptions): DocumentTranslationSourceLanguageCode | null => {
  switch (selection.type) {
    case "manual":
      return selection.language;
    case "automatic":
      return detection?.type === "detected" ? detection.language : null;
    default: {
      const exhaustiveSelection: never = selection;
      return exhaustiveSelection;
    }
  }
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
      const exhaustiveSelected: never = selected;
      return exhaustiveSelected;
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
  /**
   * What the rest of the matter is written in, most common first (the
   * preparation endpoint ranks them). `null` while the preparation has not
   * answered: nothing is known yet, which is not the same as "no other
   * documents".
   */
  matterLanguages:
    | readonly {
        language: DocumentTranslationSourceLanguageCode;
      }[]
    | null;
  /** This browser's last successful choice, or null before the first run. */
  lastUsedTarget: DocumentTranslationTargetLanguageCode | null;
  sourceLanguage: DocumentTranslationSourceLanguageCode | null;
  supportedTargets: readonly DocumentTranslationTargetLanguageCode[];
  uiLocale: string;
};

/**
 * Which language the dialog proposes translating into.
 *
 * The matter comes first: a document opened inside a matter that is otherwise
 * Czech is almost always being translated for that matter's readers, so the
 * habit of this browser and the language of this UI are both weaker evidence.
 *
 * Every branch rejects a candidate that resolves back to the source, so the
 * dialog can never open on "choose two different languages".
 */
export const defaultDocumentTranslationTarget = ({
  lastUsedTarget,
  matterLanguages,
  sourceLanguage,
  supportedTargets,
  uiLocale,
}: DefaultDocumentTranslationTargetOptions): DocumentTranslationTargetLanguageCode => {
  const offered = new Set<string>(supportedTargets);
  const translatesTheSource = (
    target: DocumentTranslationTargetLanguageCode,
  ): boolean =>
    offered.has(target) &&
    documentTranslationSourceForTarget(target) !== sourceLanguage;

  // Every source language is also an offered target, so a matter language is
  // proposable as-is; this annotation is what keeps the two catalogs bound.
  const matterTargets: DocumentTranslationTargetLanguageCode[] =
    matterLanguages === null
      ? []
      : matterLanguages.map(({ language }) => language);
  const fromMatter = matterTargets.find(translatesTheSource);
  if (fromMatter !== undefined) {
    return fromMatter;
  }
  if (lastUsedTarget !== null && translatesTheSource(lastUsedTarget)) {
    return lastUsedTarget;
  }
  const fromLocale = defaultTargetLanguage(uiLocale);
  if (translatesTheSource(fromLocale)) {
    return fromLocale;
  }
  return (
    supportedTargets.find(translatesTheSource) ??
    panic("No offered translation target differs from the source language")
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
      const exhaustiveState: never = state;
      return exhaustiveState;
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
  hasPreparedAiSource,
  hasResolvedAiSource,
  requiresCommentPolicy,
  sameLanguage,
}: CanStartDocumentTranslationOptions): boolean =>
  !isStarting &&
  !isLoadingRun &&
  (!isDeepL || canUseDeepL) &&
  (isDeepL || (hasPreparedAiSource && hasResolvedAiSource)) &&
  (!requiresCommentPolicy || hasCommentPolicy) &&
  !sameLanguage &&
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
