import { panic, Result } from "better-result";

import type { McpOAuthScope } from "@stll/api-contract";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * The restricted review account: one configured identity that signs in with
 * a password, works inside its own organization (including over MCP), and
 * cannot reach anything that changes who it is, who else it reaches, or what
 * it costs.
 */
export type ReviewAccountConfig = {
  email: string | undefined;
  organizationId: string | undefined;
};

export const REVIEW_ACCOUNT_OPERATION = {
  passwordSignIn: "password-sign-in",
  emailCodeSignIn: "email-code-sign-in",
  verifyEmail: "verify-email",
  session: "session",
  mcp: "mcp",
  createOrganization: "create-organization",
  manageOrganization: "manage-organization",
  sendInvitation: "send-invitation",
  acceptInvitation: "accept-invitation",
  joinOrganization: "join-organization",
  changeEmail: "change-email",
  changePassword: "change-password",
  enrollTwoFactor: "enroll-two-factor",
  createApiKey: "create-api-key",
  linkIdentity: "link-identity",
  deleteAccount: "delete-account",
  /**
   * Every REST handler (and its MCP write tool) declared
   * `ACCOUNT_ACCESS.accountControl`: billing writes, API keys, external MCP
   * and integration connections, provider credentials, organization
   * configuration, account deletion.
   */
  accountControlOperation: "account-control-operation",
} as const;

export type ReviewAccountOperation =
  (typeof REVIEW_ACCOUNT_OPERATION)[keyof typeof REVIEW_ACCOUNT_OPERATION];

const REVIEW_ACCOUNT_DISPOSITION = {
  allowed: "allowed",
  ownOrganization: "own-organization",
  refused: "refused",
} as const;

type ReviewAccountDisposition =
  (typeof REVIEW_ACCOUNT_DISPOSITION)[keyof typeof REVIEW_ACCOUNT_DISPOSITION];

/** What the review account may do; every new operation must pick one. */
export const REVIEW_ACCOUNT_POLICY = {
  "password-sign-in": REVIEW_ACCOUNT_DISPOSITION.allowed,
  "email-code-sign-in": REVIEW_ACCOUNT_DISPOSITION.allowed,
  "verify-email": REVIEW_ACCOUNT_DISPOSITION.allowed,
  session: REVIEW_ACCOUNT_DISPOSITION.ownOrganization,
  mcp: REVIEW_ACCOUNT_DISPOSITION.allowed,
  "create-organization": REVIEW_ACCOUNT_DISPOSITION.refused,
  "manage-organization": REVIEW_ACCOUNT_DISPOSITION.refused,
  "send-invitation": REVIEW_ACCOUNT_DISPOSITION.refused,
  "accept-invitation": REVIEW_ACCOUNT_DISPOSITION.refused,
  "join-organization": REVIEW_ACCOUNT_DISPOSITION.refused,
  "change-email": REVIEW_ACCOUNT_DISPOSITION.refused,
  "change-password": REVIEW_ACCOUNT_DISPOSITION.refused,
  "enroll-two-factor": REVIEW_ACCOUNT_DISPOSITION.refused,
  "create-api-key": REVIEW_ACCOUNT_DISPOSITION.refused,
  "link-identity": REVIEW_ACCOUNT_DISPOSITION.refused,
  "delete-account": REVIEW_ACCOUNT_DISPOSITION.refused,
  "account-control-operation": REVIEW_ACCOUNT_DISPOSITION.refused,
} as const satisfies Record<ReviewAccountOperation, ReviewAccountDisposition>;

export const REVIEW_ACCOUNT_REFUSAL_MESSAGE =
  "This operation is unavailable for this account.";

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const isReviewAccountEmail = ({
  email,
  config,
}: {
  email: string;
  config: ReviewAccountConfig;
}): boolean =>
  config.email !== undefined &&
  normalizeEmail(email) === normalizeEmail(config.email);

type ReviewAccountAccessOptions = {
  email: string;
  config: ReviewAccountConfig;
  operation: ReviewAccountOperation;
  organizationId?: unknown;
};

const refusal = () =>
  Result.err(
    new HandlerError({
      status: 403,
      code: "account_access_unavailable",
      message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
    }),
  );

export const checkReviewAccountAccess = ({
  email,
  config,
  operation,
  organizationId,
}: ReviewAccountAccessOptions): Result<void, HandlerError> => {
  if (!isReviewAccountEmail({ email, config })) {
    return Result.ok();
  }
  // Without its organization the account has nowhere it may work.
  if (config.organizationId === undefined) {
    return refusal();
  }
  const disposition: ReviewAccountDisposition =
    REVIEW_ACCOUNT_POLICY[operation];
  switch (disposition) {
    case REVIEW_ACCOUNT_DISPOSITION.allowed:
      return Result.ok();
    case REVIEW_ACCOUNT_DISPOSITION.ownOrganization:
      return organizationId === config.organizationId ? Result.ok() : refusal();
    case REVIEW_ACCOUNT_DISPOSITION.refused:
      return refusal();
    default:
      disposition satisfies never;
      return panic(
        `Unhandled review account disposition: ${String(disposition)}`,
      );
  }
};

/**
 * Better Auth endpoints that act on the signed-in account, by the operation
 * they perform. `/organization/set-active` stays open: the account belongs to
 * one organization, and the session rule refuses any other.
 */
const SESSION_AUTH_PATH_OPERATIONS: Readonly<
  Record<string, ReviewAccountOperation>
> = {
  "/organization/create": REVIEW_ACCOUNT_OPERATION.createOrganization,
  "/organization/invite-member": REVIEW_ACCOUNT_OPERATION.sendInvitation,
  "/organization/accept-invitation": REVIEW_ACCOUNT_OPERATION.acceptInvitation,
  "/change-email": REVIEW_ACCOUNT_OPERATION.changeEmail,
  "/email-otp/request-email-change": REVIEW_ACCOUNT_OPERATION.changeEmail,
  "/email-otp/change-email": REVIEW_ACCOUNT_OPERATION.changeEmail,
  "/change-password": REVIEW_ACCOUNT_OPERATION.changePassword,
  "/link-social": REVIEW_ACCOUNT_OPERATION.linkIdentity,
  // Unlinking the credential identity would end password sign-in.
  "/unlink-account": REVIEW_ACCOUNT_OPERATION.linkIdentity,
  "/delete-user": REVIEW_ACCOUNT_OPERATION.deleteAccount,
  "/delete-user/callback": REVIEW_ACCOUNT_OPERATION.deleteAccount,
};

const SESSION_AUTH_PATH_PREFIX_OPERATIONS: readonly (readonly [
  string,
  ReviewAccountOperation,
])[] = [
  ["/two-factor/", REVIEW_ACCOUNT_OPERATION.enrollTwoFactor],
  ["/api-key/", REVIEW_ACCOUNT_OPERATION.createApiKey],
];

const ORGANIZATION_SESSION_PATHS_OPEN = new Set(["/organization/set-active"]);

/** The operation a signed-in request to this auth endpoint performs. */
export const resolveReviewAccountSessionOperation = ({
  path,
  method,
}: {
  path: string;
  method: string | undefined;
}): ReviewAccountOperation | null => {
  if (Object.hasOwn(SESSION_AUTH_PATH_OPERATIONS, path)) {
    return SESSION_AUTH_PATH_OPERATIONS[path] ?? null;
  }
  const prefixed = SESSION_AUTH_PATH_PREFIX_OPERATIONS.find(([prefix]) =>
    path.startsWith(prefix),
  );
  if (prefixed !== undefined) {
    return prefixed[1];
  }
  if (
    path.startsWith("/organization/") &&
    method !== "GET" &&
    !ORGANIZATION_SESSION_PATHS_OPEN.has(path)
  ) {
    return REVIEW_ACCOUNT_OPERATION.manageOrganization;
  }
  return null;
};

/**
 * Organization endpoints name the organization they act on in the body or the
 * query, apart from the session's active organization. For the review
 * account each named target is checked, not only the session.
 */
export const isReviewAccountTargetCheckedPath = (path: string): boolean =>
  path.startsWith("/organization/");

type OrganizationTargets = {
  /** `null` asks to clear the active organization. */
  ids: (string | null)[];
  slugs: string[];
};

const readTargets = (source: unknown, targets: OrganizationTargets) => {
  if (typeof source !== "object" || source === null) {
    return;
  }
  if (Object.hasOwn(source, "organizationId")) {
    const id: unknown = Reflect.get(source, "organizationId");
    if (typeof id === "string" || id === null) {
      targets.ids.push(id);
    }
  }
  const slug: unknown = Reflect.get(source, "organizationSlug");
  if (typeof slug === "string") {
    targets.slugs.push(slug);
  }
};

export const readReviewAccountOrganizationTargets = ({
  path,
  body,
  query,
}: {
  path: string;
  body: unknown;
  query: unknown;
}): OrganizationTargets => {
  const targets: OrganizationTargets = { ids: [], slugs: [] };
  if (isReviewAccountTargetCheckedPath(path)) {
    readTargets(body, targets);
    readTargets(query, targets);
  }
  return targets;
};

/**
 * Endpoints that name the account by an `email` in the body rather than by a
 * session: password recovery and sign-up would let whoever reads the
 * account's mailbox replace its password.
 */
const BODY_EMAIL_AUTH_PATH_OPERATIONS: Readonly<
  Record<string, ReviewAccountOperation>
> = {
  "/sign-up/email": REVIEW_ACCOUNT_OPERATION.changePassword,
  // Email codes redeemed by address: checked, and allowed.
  "/sign-in/email-otp": REVIEW_ACCOUNT_OPERATION.emailCodeSignIn,
  "/email-otp/verify-email": REVIEW_ACCOUNT_OPERATION.verifyEmail,
  "/email-otp/check-verification-otp": REVIEW_ACCOUNT_OPERATION.verifyEmail,
  "/request-password-reset": REVIEW_ACCOUNT_OPERATION.changePassword,
  "/email-otp/request-password-reset": REVIEW_ACCOUNT_OPERATION.changePassword,
  "/forget-password/email-otp": REVIEW_ACCOUNT_OPERATION.changePassword,
  "/email-otp/reset-password": REVIEW_ACCOUNT_OPERATION.changePassword,
};

const SEND_VERIFICATION_OTP_PATH = "/email-otp/send-verification-otp";

export const isReviewAccountBodyEmailPath = (path: string): boolean =>
  path === SEND_VERIFICATION_OTP_PATH ||
  Object.hasOwn(BODY_EMAIL_AUTH_PATH_OPERATIONS, path);

export const resolveReviewAccountBodyEmailOperation = ({
  path,
  otpType,
}: {
  path: string;
  otpType: unknown;
}): ReviewAccountOperation | null => {
  if (path === SEND_VERIFICATION_OTP_PATH) {
    return otpType === "forget-password"
      ? REVIEW_ACCOUNT_OPERATION.changePassword
      : null;
  }
  return Object.hasOwn(BODY_EMAIL_AUTH_PATH_OPERATIONS, path)
    ? (BODY_EMAIL_AUTH_PATH_OPERATIONS[path] ?? null)
    : null;
};

/** Scopes a token for the review organization never carries. */
export const REVIEW_ACCOUNT_EXCLUDED_SCOPES = [
  "stella:admin_read",
  "stella:admin_write",
  "stella:billing_write",
  "stella:external_mcps",
] as const satisfies readonly McpOAuthScope[];

const EXCLUDED_SCOPE_SET: ReadonlySet<string> = new Set(
  REVIEW_ACCOUNT_EXCLUDED_SCOPES,
);

/**
 * Drops the excluded scopes from a credential that opens the review
 * organization. Keyed by organization so the check needs no account lookup:
 * the organization exists only for the review account.
 */
export const narrowReviewOrganizationScopes = <
  T extends { organizationId: string; scopes: string[] },
>(
  session: T,
  config: Pick<ReviewAccountConfig, "organizationId">,
): T =>
  config.organizationId !== undefined &&
  session.organizationId === config.organizationId
    ? {
        ...session,
        scopes: session.scopes.filter(
          (scope) => !EXCLUDED_SCOPE_SET.has(scope),
        ),
      }
    : session;
