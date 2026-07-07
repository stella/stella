type EmailTransportConfig = {
  emailProvider: "ses" | "smtp" | undefined;
  sesAccessKeyId: string | undefined;
  sesRegion: string | undefined;
  sesSecretAccessKey: string | undefined;
  smtpHost: string | undefined;
  smtpPassword: string | undefined;
  smtpPort: number | undefined;
  smtpUsername: string | undefined;
  transactionalEmailFrom: string | undefined;
};

const hasCompleteOptionalPair = (
  first: string | undefined,
  second: string | undefined,
): boolean => Boolean(first) === Boolean(second);

export const isEmailTransportConfigComplete = ({
  emailProvider,
  sesAccessKeyId,
  sesRegion,
  sesSecretAccessKey,
  smtpHost,
  smtpPassword,
  smtpPort,
  smtpUsername,
  transactionalEmailFrom,
}: EmailTransportConfig): boolean => {
  if (!transactionalEmailFrom) {
    return false;
  }

  switch (emailProvider) {
    case "ses":
      return (
        !!sesRegion &&
        hasCompleteOptionalPair(sesAccessKeyId, sesSecretAccessKey)
      );
    case "smtp":
      return (
        !!smtpHost &&
        smtpPort !== undefined &&
        hasCompleteOptionalPair(smtpUsername, smtpPassword)
      );
    case undefined:
      return false;
    default: {
      const _exhaustive: never = emailProvider;
      return _exhaustive;
    }
  }
};
