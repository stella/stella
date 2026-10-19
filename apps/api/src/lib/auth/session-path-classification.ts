const AUTH_SESSION_PATH_DISPOSITION = {
  secondFactor: "second_factor",
  noSecondFactor: "no_second_factor",
  existingSession: "existing_session",
  noSession: "no_session",
} as const;

type AuthSessionPathClassification =
  | { disposition: "second_factor" }
  | { disposition: "no_second_factor"; reason: string }
  | { disposition: "existing_session"; reason: string }
  | { disposition: "no_session"; reason: string };

const SECOND_FACTOR = {
  disposition: AUTH_SESSION_PATH_DISPOSITION.secondFactor,
} as const satisfies AuthSessionPathClassification;

const noSecondFactor = (reason: string): AuthSessionPathClassification => ({
  disposition: AUTH_SESSION_PATH_DISPOSITION.noSecondFactor,
  reason,
});

const existingSession = (reason: string): AuthSessionPathClassification => ({
  disposition: AUTH_SESSION_PATH_DISPOSITION.existingSession,
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
    ["/email-otp/verify-email", noSecondFactor("first email verification")],
    ["/sign-up/email", noSession("self-hosted password registration")],
    ["/verify-email", noSession("email verification")],
    ["/get-session", existingSession("authenticated session refresh")],
    ["/update-session", existingSession("authenticated session update")],
    ["/update-user", existingSession("authenticated user update")],
    ["/change-email", existingSession("authenticated email change")],
    ["/email-otp/change-email", existingSession("authenticated email change")],
    ["/two-factor/enable", existingSession("second-factor enrollment")],
    ["/two-factor/disable", existingSession("second-factor removal")],
    [
      "/two-factor/verify-backup-code",
      existingSession("second-factor challenge completion"),
    ],
    [
      "/two-factor/verify-otp",
      existingSession("second-factor challenge completion"),
    ],
    [
      "/two-factor/verify-totp",
      existingSession("second-factor challenge completion"),
    ],
    [
      "/organization/set-active",
      existingSession("authenticated organization selection"),
    ],
    [
      "/organization/accept-invitation",
      existingSession("authenticated organization invitation acceptance"),
    ],
    ["/account-info", noSession("OAuth account information")],
    ["/agent-identity/create-user", noSession("agent account provisioning")],
    ["/change-password", noSession("authenticated credential update")],
    ["/delete-user", noSession("authenticated account removal")],
    ["/delete-user/callback", noSession("account removal callback")],
    ["/error", noSession("authentication error response")],
    [
      "/email-otp/send-verification-otp",
      noSession("verification message request"),
    ],
    ["/email-otp/check-verification-otp", noSession("verification code check")],
    ["/email-otp/request-password-reset", noSession("password reset request")],
    ["/email-otp/reset-password", noSession("password reset")],
    [
      "/email-otp/request-email-change",
      noSession("email change message request"),
    ],
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
    ["/two-factor/get-totp-uri", noSession("enrollment code request")],
    ["/two-factor/send-otp", noSession("challenge message request")],
    [
      "/two-factor/generate-backup-codes",
      noSession("recovery code generation"),
    ],
    ["/unlink-account", noSession("authenticated account unlinking")],
    ["/verify-password", noSession("authenticated credential verification")],
    ["/organization/create", noSession("organization management")],
    ["/organization/update", noSession("organization management")],
    ["/organization/delete", noSession("organization management")],
    ["/organization/get-organization", noSession("organization lookup")],
    ["/organization/get-full-organization", noSession("organization lookup")],
    ["/organization/list", noSession("organization listing")],
    ["/organization/invite-member", noSession("membership management")],
    ["/organization/cancel-invitation", noSession("membership management")],
    ["/organization/get-invitation", noSession("invitation lookup")],
    ["/organization/reject-invitation", noSession("invitation response")],
    ["/organization/list-invitations", noSession("invitation listing")],
    ["/organization/get-active-member", noSession("active membership lookup")],
    ["/organization/check-slug", noSession("organization slug check")],
    ["/organization/remove-member", noSession("membership management")],
    ["/organization/update-member-role", noSession("membership management")],
    ["/organization/list-user-invitations", noSession("invitation listing")],
    ["/organization/list-members", noSession("membership listing")],
    [
      "/organization/get-active-member-role",
      noSession("active membership lookup"),
    ],
    ["/organization/has-permission", noSession("membership permission check")],
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
    prefix: "/oauth2/",
    classification: noSession("OAuth authorization-server endpoint"),
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
