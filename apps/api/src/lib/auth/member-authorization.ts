import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { UserProfessionalUseState } from "@/api/lib/auth/professional-use";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Resolve the user's organization role and, when the route already carries a
 * workspace ID, that single workspace's status. Both branches are bounded to
 * one row; request authentication never expands the full access set.
 */
export type MemberAuthorizationLookup = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId?: SafeId<"workspace"> | undefined;
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
};

export type ResolveCredentialMemberAuthorization = (
  lookup: MemberAuthorizationLookup,
) => Promise<MemberAuthorization | null>;
