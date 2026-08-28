import type {
  DocumentTranslationRunErrorCode,
  DocumentTranslationSourceLanguageCode,
  DocumentTranslationSourceLanguageDetection,
} from "@stll/api-contract/document-translation";

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
