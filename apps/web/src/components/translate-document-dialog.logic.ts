import type {
  DocumentTranslationSourceLanguageCode,
  DocumentTranslationSourceLanguageDetection,
} from "@stll/api-contract/document-translation";

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
