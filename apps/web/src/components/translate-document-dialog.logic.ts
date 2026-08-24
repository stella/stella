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
