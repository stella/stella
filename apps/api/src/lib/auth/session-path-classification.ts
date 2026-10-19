const AUTH_SESSION_PATH_DISPOSITION = {
  secondFactor: "second_factor",
  noSecondFactor: "no_second_factor",
  noSession: "no_session",
} as const;

type AuthSessionPathClassification =
  | { disposition: "second_factor" }
  | { disposition: "no_second_factor"; reason: string }
  | { disposition: "no_session"; reason: string };

const SECOND_FACTOR = {
  disposition: AUTH_SESSION_PATH_DISPOSITION.secondFactor,
} as const satisfies AuthSessionPathClassification;

const noSecondFactor = (reason: string): AuthSessionPathClassification => ({
  disposition: AUTH_SESSION_PATH_DISPOSITION.noSecondFactor,
  reason,
});

const noSession = (reason: string): AuthSessionPathClassification => ({
  disposition: AUTH_SESSION_PATH_DISPOSITION.noSession,
  reason,
});

const EXACT_AUTH_SESSION_PATHS = new Map<string, AuthSessionPathClassification>(
  [
    ["/sign-in/email-otp", SECOND_FACTOR],
    ["/sign-in/social", SECOND_FACTOR],
    ["/sign-in/email", noSecondFactor("self-hosted password sign-in")],
    ["/sign-up/email", noSecondFactor("self-hosted password registration")],
    ["/email-otp/verify-email", noSecondFactor("first email verification")],
    ["/verify-email", noSecondFactor("email verification")],
    ["/get-session", noSecondFactor("authenticated session refresh")],
    ["/update-session", noSecondFactor("authenticated session update")],
    ["/update-user", noSecondFactor("authenticated user update")],
    ["/change-email", noSecondFactor("authenticated email change")],
    ["/email-otp/change-email", noSecondFactor("authenticated email change")],
    ["/two-factor/enable", noSecondFactor("second-factor enrollment")],
    ["/two-factor/disable", noSecondFactor("second-factor removal")],
    [
      "/two-factor/verify-backup-code",
      noSecondFactor("second-factor challenge completion"),
    ],
    [
      "/two-factor/verify-otp",
      noSecondFactor("second-factor challenge completion"),
    ],
    [
      "/two-factor/verify-totp",
      noSecondFactor("second-factor challenge completion"),
    ],
    [
      "/organization/set-active",
      noSecondFactor("authenticated organization selection"),
    ],
    [
      "/organization/accept-invitation",
      noSecondFactor("authenticated organization invitation acceptance"),
    ],
    ["/account-info", noSession("OAuth account information")],
    ["/agent-identity/create-user", noSession("agent account provisioning")],
    ["/change-password", noSession("authenticated credential update")],
    ["/delete-user", noSession("authenticated account removal")],
    ["/delete-user/callback", noSession("account removal callback")],
    ["/error", noSession("authentication error response")],
    ["/forget-password/email-otp", noSession("password reset request")],
    ["/get-access-token", noSession("access-token exchange")],
    ["/jwks", noSession("public key metadata")],
    ["/link-social", noSession("authenticated account linking")],
    ["/list-accounts", noSession("authenticated account listing")],
    ["/list-sessions", noSession("authenticated session listing")],
    ["/ok", noSession("authentication status response")],
    ["/refresh-token", noSession("access-token refresh")],
    ["/request-password-reset", noSession("password reset request")],
    ["/reset-password", noSession("password reset")],
    ["/reset-password/:token", noSession("password reset page")],
    ["/review-account/create-user", noSession("review account provisioning")],
    ["/revoke-other-sessions", noSession("authenticated session revocation")],
    ["/revoke-session", noSession("authenticated session revocation")],
    ["/revoke-session-by-id", noSession("authenticated session revocation")],
    ["/revoke-sessions", noSession("authenticated session revocation")],
    ["/send-verification-email", noSession("verification message request")],
    ["/sign-out", noSession("session removal")],
    ["/social-link-hint", noSession("social account lookup")],
    ["/token", noSession("token exchange")],
    ["/unlink-account", noSession("authenticated account unlinking")],
    ["/verify-password", noSession("authenticated credential verification")],
  ],
);

const AUTH_SESSION_PATH_PREFIXES: readonly {
  prefix: string;
  classification: AuthSessionPathClassification;
}[] = [
  { prefix: "/callback/", classification: SECOND_FACTOR },
  {
    prefix: "/.well-known/",
    classification: noSession("OAuth server metadata"),
  },
  {
    prefix: "/admin/oauth2/",
    classification: noSession("OAuth client administration"),
  },
  {
    prefix: "/api-key/",
    classification: noSession("API key management"),
  },
  {
    prefix: "/email-otp/",
    classification: noSession("email verification message or code handling"),
  },
  {
    prefix: "/oauth2/",
    classification: noSession("OAuth authorization-server endpoint"),
  },
  {
    prefix: "/organization/",
    classification: noSession("organization management"),
  },
  {
    prefix: "/two-factor/",
    classification: noSession("second-factor management"),
  },
];

export const classifyAuthSessionPath = (
  path: string | undefined,
): AuthSessionPathClassification | undefined => {
  if (path === undefined) {
    return undefined;
  }

  const exactClassification = EXACT_AUTH_SESSION_PATHS.get(path);
  if (exactClassification) {
    return exactClassification;
  }

  return AUTH_SESSION_PATH_PREFIXES.find(({ prefix }) =>
    path.startsWith(prefix),
  )?.classification;
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
