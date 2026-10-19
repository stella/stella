const AUTH_SESSION_PATH_DISPOSITION = {
  secondFactor: "second_factor",
  noSecondFactor: "no_second_factor",
  notBrowserSession: "not_browser_session",
} as const;

type AuthSessionPathClassification =
  | { disposition: "second_factor" }
  | { disposition: "no_second_factor"; reason: string }
  | { disposition: "not_browser_session"; reason: string };

const EXACT_AUTH_SESSION_PATHS = new Map<string, AuthSessionPathClassification>(
  [
    [
      "/sign-in/email-otp",
      {
        disposition: AUTH_SESSION_PATH_DISPOSITION.secondFactor,
      },
    ],
    [
      "/sign-in/social",
      {
        disposition: AUTH_SESSION_PATH_DISPOSITION.secondFactor,
      },
    ],
    [
      "/sign-in/email",
      {
        disposition: AUTH_SESSION_PATH_DISPOSITION.noSecondFactor,
        reason: "self-hosted password sign-in",
      },
    ],
    [
      "/sign-up/email",
      {
        disposition: AUTH_SESSION_PATH_DISPOSITION.noSecondFactor,
        reason: "self-hosted password registration",
      },
    ],
    [
      "/email-otp/verify-email",
      {
        disposition: AUTH_SESSION_PATH_DISPOSITION.noSecondFactor,
        reason: "first email verification",
      },
    ],
    [
      "/verify-email",
      {
        disposition: AUTH_SESSION_PATH_DISPOSITION.noSecondFactor,
        reason: "email verification",
      },
    ],
  ],
);

export const classifyAuthSessionPath = (
  path: string | undefined,
): AuthSessionPathClassification | undefined => {
  if (path === undefined) {
    return undefined;
  }
  if (path.startsWith("/callback/")) {
    return { disposition: AUTH_SESSION_PATH_DISPOSITION.secondFactor };
  }
  if (path.startsWith("/oauth2/")) {
    return {
      disposition: AUTH_SESSION_PATH_DISPOSITION.notBrowserSession,
      reason: "OAuth authorization-server endpoint",
    };
  }
  return EXACT_AUTH_SESSION_PATHS.get(path);
};

export const isSecondFactorAuthSessionPath = (
  path: string | undefined,
): boolean =>
  classifyAuthSessionPath(path)?.disposition ===
  AUTH_SESSION_PATH_DISPOSITION.secondFactor;

export const isSessionCreatingAuthPath = (
  path: string | undefined,
): boolean => {
  const classification = classifyAuthSessionPath(path);
  return (
    classification?.disposition ===
      AUTH_SESSION_PATH_DISPOSITION.secondFactor ||
    classification?.disposition === AUTH_SESSION_PATH_DISPOSITION.noSecondFactor
  );
};
