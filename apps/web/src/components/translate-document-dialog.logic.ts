type CanStartDocumentTranslationOptions = {
  canUseDeepL: boolean;
  isDeepL: boolean;
  isLoadingRun: boolean;
  isRunning: boolean;
  isStarting: boolean;
  hasCommentPolicy: boolean;
  requiresCommentPolicy: boolean;
  sameLanguage: boolean;
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
  requiresCommentPolicy,
  sameLanguage,
}: CanStartDocumentTranslationOptions): boolean =>
  !isStarting &&
  !isLoadingRun &&
  (!isDeepL || canUseDeepL) &&
  (!requiresCommentPolicy || hasCommentPolicy) &&
  !sameLanguage &&
  !isRunning;
