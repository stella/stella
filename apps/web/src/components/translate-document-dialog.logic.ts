type CanStartDocumentTranslationOptions = {
  canUseDeepL: boolean;
  isDeepL: boolean;
  isLoadingRun: boolean;
  isRunning: boolean;
  isStarting: boolean;
  sameLanguage: boolean;
};

export const canStartDocumentTranslation = ({
  canUseDeepL,
  isDeepL,
  isLoadingRun,
  isRunning,
  isStarting,
  sameLanguage,
}: CanStartDocumentTranslationOptions): boolean =>
  !isStarting &&
  !isLoadingRun &&
  (!isDeepL || canUseDeepL) &&
  !sameLanguage &&
  !isRunning;
