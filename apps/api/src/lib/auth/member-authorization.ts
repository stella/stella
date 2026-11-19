import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { UserProfessionalUseState } from "@/api/lib/auth/professional-use";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * How the caller proved who they are, which decides whether an
 * organization's single sign-on requirement is evaluated: a browser session
 * is held to it through the provider that created the session. Every other
 * credential (an app's access token, a machine key, work the server
 * started) is not evaluated against it yet.
 */
export type MemberAuthentication =
  { kind: "browser_session"; sessionId: string } | { kind: "credential" };

/**
 * Resolve the user's organization role and, when the route already carries a
 * workspace ID, that single workspace's status. Both branches are bounded to
 * one row; request authentication never expands the full access set.
 */
export type MemberAuthorizationLookup = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId?: SafeId<"workspace"> | undefined;
  authentication: MemberAuthentication;
};

/** The lookup a credential boundary makes; see {@link MemberAuthentication}. */
export type CredentialMemberAuthorizationLookup = Omit<
  MemberAuthorizationLookup,
  "authentication"
>;

export const SSO_ACCESS_STATUS = {
  /** The organization does not require SSO, or SSO is not deployed. */
  notRequired: "not_required",
  /** One of the organization's providers created this browser session. */
  satisfied: "satisfied",
  /** The organization requires SSO and none of its providers created the session. */
  signInRequired: "sign_in_required",
  /** A credential the requirement is not evaluated for yet. */
  notEvaluated: "not_evaluated",
} as const;

/** Whether the organization's SSO requirement admits this caller. */
export type SsoAccess = {
  status: (typeof SSO_ACCESS_STATUS)[keyof typeof SSO_ACCESS_STATUS];
};

export type MemberAuthorization = {
  memberId: string;
  email: string;
  /** Raw DB value; callers validate it with isMemberRole. */
  role: string;
  billingAccess: boolean;
  workspace: AccessibleWorkspace | null;
  /**
   * Feature-access facts read in the same statement, so gated routes decide
   * feature access without a query of their own.
   */
  emailVerified: boolean;
  userDeleted: boolean;
  enrolledFeatureIds: readonly string[];
  /**
   * The account's professional-use state, read in the same statement: a
   * signed-in session requires `accepted`.
   */
  professionalUse: UserProfessionalUseState;
  /**
   * The organization's SSO requirement against this caller, read in the same
   * statement: `sign_in_required` refuses this organization only.
   */
  ssoAccess: SsoAccess;
};

export type ResolveCredentialMemberAuthorization = (
  lookup: CredentialMemberAuthorizationLookup,
) => Promise<MemberAuthorization | null>;
