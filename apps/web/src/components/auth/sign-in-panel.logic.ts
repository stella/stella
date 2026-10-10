export type AuthCapabilities = {
  emailOtp: boolean;
  localPassword: boolean;
  /** Password sign-in for one configured account only: offered quietly. */
  reviewPasswordSignIn: boolean;
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

  return {
    showEmailOtp: authCapabilities.emailOtp,
    showLocalPassword,
    showBootstrap: authCapabilities.bootstrap,
    showReviewPasswordSignIn:
      authCapabilities.reviewPasswordSignIn &&
      !showLocalPassword &&
      !authCapabilities.bootstrap,
    showGoogle,
    showMicrosoft,
    showSocialProviders,
    hasAboveEmailOptions: showSocialProviders || showLocalPassword,
  };
};

/**
 * Sign-in methods as better-auth's last-login-method plugin names them in
 * its browser cookie (set only after a sign-in succeeds; the value is the
 * method name, never the account).
 */
export const SIGN_IN_METHOD = {
  google: "google",
  microsoft: "microsoft",
  emailOtp: "email-otp",
  password: "email",
} as const;

export type SignInMethod = (typeof SIGN_IN_METHOD)[keyof typeof SIGN_IN_METHOD];

type SignInOptions = ReturnType<typeof resolveSignInOptions>;

const isMethodShown: Record<SignInMethod, (options: SignInOptions) => boolean> =
  {
    [SIGN_IN_METHOD.google]: (options) => options.showGoogle,
    [SIGN_IN_METHOD.microsoft]: (options) => options.showMicrosoft,
    [SIGN_IN_METHOD.emailOtp]: (options) => options.showEmailOtp,
    [SIGN_IN_METHOD.password]: (options) =>
      options.showLocalPassword && !options.showBootstrap,
  };

const isSignInMethod = (value: string): value is SignInMethod =>
  Object.hasOwn(isMethodShown, value);

/**
 * The method this browser last signed in with, when this page offers it.
 * An unknown value, or a method the deployment no longer offers, gets no
 * emphasis.
 */
export const resolveLastUsedSignInMethod = ({
  stored,
  options,
}: {
  stored: string | null;
  options: SignInOptions;
}): SignInMethod | null =>
  stored !== null && isSignInMethod(stored) && isMethodShown[stored](options)
    ? stored
    : null;

/**
 * Only the last-used method is the filled primary action. Without one, each
 * method keeps its normal emphasis.
 */
export const signInMethodVariant = ({
  method,
  lastUsed,
  fallback,
}: {
  method: SignInMethod;
  lastUsed: SignInMethod | null;
  fallback: "default" | "outline";
}): "default" | "outline" => {
  if (lastUsed === null) {
    return fallback;
  }
  return lastUsed === method ? "default" : "outline";
};
