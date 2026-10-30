import type { AuthSocialProviderId } from "@stll/auth-model";

/** One flag per social provider the API knows. */
type SocialProviderFlags = Record<AuthSocialProviderId, boolean>;

export type AuthCapabilities = {
  emailOtp: boolean;
  localPassword: boolean;
  /** Password sign-in for one configured account only: offered quietly. */
  reviewPasswordSignIn: boolean;
  bootstrap: boolean;
  social: SocialProviderFlags;
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
  const showApple = socialProviderFlags.apple && authCapabilities.social.apple;
  const showSocialProviders = showGoogle || showMicrosoft || showApple;
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
    showReviewPasswordSignIn:
      authCapabilities.reviewPasswordSignIn &&
      !showLocalPassword &&
      !authCapabilities.bootstrap,
    showGoogle,
    showMicrosoft,
    showApple,
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
  apple: "apple",
  emailOtp: "email-otp",
  password: "email",
} as const;

export type SignInMethod = (typeof SIGN_IN_METHOD)[keyof typeof SIGN_IN_METHOD];

type SignInOptions = ReturnType<typeof resolveSignInOptions>;

const isMethodShown: Record<SignInMethod, (options: SignInOptions) => boolean> =
  {
    [SIGN_IN_METHOD.google]: (options) => options.showGoogle,
    [SIGN_IN_METHOD.microsoft]: (options) => options.showMicrosoft,
    [SIGN_IN_METHOD.apple]: (options) => options.showApple,
    [SIGN_IN_METHOD.emailOtp]: (options) => options.showEmailOtp,
    [SIGN_IN_METHOD.password]: (options) =>
      options.showLocalPassword && !options.showBootstrap,
  };

const isSignInMethod = (value: string): value is SignInMethod =>
  Object.hasOwn(isMethodShown, value);

const SIGN_IN_METHODS = Object.values(SIGN_IN_METHOD);

/** The quiet password option is a choice too, though it carries no badge. */
const offeredMethodCount = (options: SignInOptions) =>
  SIGN_IN_METHODS.filter((method) => isMethodShown[method](options)).length +
  (options.showReviewPasswordSignIn ? 1 : 0);

/**
 * The method this browser last signed in with, when this page offers it
 * among other methods. An unknown value, a method the deployment no longer
 * offers, or the only method on the page gets no emphasis.
 */
export const resolveLastUsedSignInMethod = ({
  stored,
  options,
}: {
  stored: string | null;
  options: SignInOptions;
}): SignInMethod | null =>
  stored !== null &&
  isSignInMethod(stored) &&
  isMethodShown[stored](options) &&
  offeredMethodCount(options) > 1
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
