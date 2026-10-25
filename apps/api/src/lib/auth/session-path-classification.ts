import { MCP_HANDOFF_REDEEM_PATH } from "@/api/lib/auth/mcp-web-handoff-paths";

const AUTH_SESSION_PATH_DISPOSITION = {
  secondFactor: "second_factor",
  secondFactorCompletion: "second_factor_completion",
  noSecondFactor: "no_second_factor",
  existingSession: "existing_session",
  noSession: "no_session",
} as const;

type AuthSessionPathClassification =
  | { disposition: "second_factor" }
  | { disposition: "second_factor_completion"; reason: string }
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

const secondFactorCompletion = (
  reason: string,
): AuthSessionPathClassification => ({
  disposition: AUTH_SESSION_PATH_DISPOSITION.secondFactorCompletion,
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
    ["/sign-up/email", noSecondFactor("self-hosted password registration")],
    [
      MCP_HANDOFF_REDEEM_PATH,
      noSecondFactor("web session handed off from an authorized MCP session"),
    ],
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
      secondFactorCompletion("second-factor challenge completion"),
    ],
    [
      "/two-factor/verify-otp",
      secondFactorCompletion("second-factor challenge completion"),
    ],
    [
      "/two-factor/verify-totp",
      secondFactorCompletion("second-factor challenge completion"),
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
    ["/mcp-handoff/sessions", noSession("handed-off session client listing")],
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
    ["/oauth2/authorize", noSession("OAuth authorization request")],
    ["/oauth2/consent", noSession("OAuth consent submission")],
    ["/oauth2/consent-info", noSession("OAuth consent information")],
    ["/oauth2/continue", noSession("OAuth authorization continuation")],
    ["/oauth2/delete-consent", noSession("OAuth consent removal")],
    ["/oauth2/end-session", noSession("OAuth session end request")],
    [
      "/oauth2/end-session/confirm",
      noSession("OAuth session end confirmation"),
    ],
    ["/oauth2/get-client", noSession("OAuth client lookup")],
    ["/oauth2/get-clients", noSession("OAuth client listing")],
    ["/oauth2/get-consent", noSession("OAuth consent lookup")],
    ["/oauth2/get-consents", noSession("OAuth consent listing")],
    ["/oauth2/introspect", noSession("OAuth token introspection")],
    ["/oauth2/public-client", noSession("OAuth public client lookup")],
    [
      "/oauth2/public-client-prelogin",
      noSession("OAuth public client pre-login lookup"),
    ],
    ["/oauth2/register", noSession("OAuth client registration")],
    ["/oauth2/revoke", noSession("OAuth token revocation")],
    ["/oauth2/token", noSession("OAuth token exchange")],
    ["/oauth2/userinfo", noSession("OAuth user information")],
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

export const isNewDeviceNoticeAuthPath = (
  path: string | undefined,
): boolean => {
  const classification = classifyAuthSessionPath(path);
  return (
    classification?.disposition ===
      AUTH_SESSION_PATH_DISPOSITION.secondFactorCompletion ||
    classification?.disposition ===
      AUTH_SESSION_PATH_DISPOSITION.secondFactor ||
    classification?.disposition === AUTH_SESSION_PATH_DISPOSITION.noSecondFactor
  );
};
