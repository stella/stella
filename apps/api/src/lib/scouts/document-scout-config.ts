type DocumentScoutEnvironment = {
  FEATURE_INBOX_DOCUMENT_SCOUTS: boolean;
  isDev: boolean;
};

export const documentScoutsEnabled = ({
  FEATURE_INBOX_DOCUMENT_SCOUTS,
  isDev,
}: DocumentScoutEnvironment): boolean => isDev || FEATURE_INBOX_DOCUMENT_SCOUTS;
