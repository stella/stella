export type AuthCapabilities = {
  emailOtp: boolean;
  localPassword: boolean;
  bootstrap: boolean;
  social: {
    google: boolean;
    microsoft: boolean;
  };
};

type SocialProviderFlags = {
  google: boolean;
  microsoft: boolean;
};

export const resolveSignInOptions = ({
  authCapabilities,
  socialProviderFlags,
}: {
  authCapabilities: AuthCapabilities;
  socialProviderFlags: SocialProviderFlags;
}) => {
  const showGoogle =
    socialProviderFlags.google && authCapabilities.social.google;
  const showMicrosoft =
    socialProviderFlags.microsoft && authCapabilities.social.microsoft;
  const showSocialProviders = showGoogle || showMicrosoft;
  const showLocalPassword = authCapabilities.localPassword;
  // Email OTP, social sign-in and the first-user bootstrap create an account
  // for a new address; a local password only signs an existing one in.
  const accountCreation =
    authCapabilities.emailOtp ||
    showSocialProviders ||
    authCapabilities.bootstrap
      ? "offered"
      : "not_offered";

  return {
    accountCreation,
    showEmailOtp: authCapabilities.emailOtp,
    showLocalPassword,
    showBootstrap: authCapabilities.bootstrap,
    showGoogle,
    showMicrosoft,
    showSocialProviders,
    hasAboveEmailOptions: showSocialProviders || showLocalPassword,
  };
};
