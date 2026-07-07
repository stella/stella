import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import {
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session as sessionTable,
} from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";

type RevokeOrganizationMemberAuthArtifactsOptions = {
  organizationId: string;
  userId: string;
};

export const revokeOrganizationMemberAuthArtifacts = async (
  tx: Transaction,
  { organizationId, userId }: RevokeOrganizationMemberAuthArtifactsOptions,
): Promise<void> => {
  await tx
    .delete(oauthAccessToken)
    .where(
      and(
        eq(oauthAccessToken.userId, userId),
        eq(oauthAccessToken.referenceId, organizationId),
      ),
    );

  await tx
    .delete(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        eq(oauthRefreshToken.referenceId, organizationId),
      ),
    );

  // Org-scoped consent grants die with the membership: leaving them behind
  // would keep the organization listed on the ex-member's connected-apps
  // page and let a client silently re-mint tokens on the next authorize.
  await tx
    .delete(oauthConsent)
    .where(
      and(
        eq(oauthConsent.userId, userId),
        eq(oauthConsent.referenceId, organizationId),
      ),
    );

  await tx
    .delete(sessionTable)
    .where(
      and(
        eq(sessionTable.userId, userId),
        eq(sessionTable.activeOrganizationId, organizationId),
      ),
    );
};

type RevokeOAuthClientAuthArtifactsOptions = {
  userId: SafeId<"user">;
  clientId: string;
  /**
   * The consent's organization scope. Token revocation matches it exactly:
   * an org-scoped grant only revokes that organization's tokens, and a
   * `null` (org-unscoped) grant only revokes tokens that carry no
   * organization, so sibling grants of the same client stay intact.
   */
  referenceId: string | null;
};

/**
 * Revokes every OAuth token one client holds for one user under one grant
 * (per-consent disconnect from the connections settings page). Unlike
 * `revokeOrganizationMemberAuthArtifacts` this must NOT touch `session`
 * rows: disconnecting an OAuth app ends that app's access, not the
 * user's own web sessions.
 *
 * Access tokens are verified statelessly (JWT via JWKS), so an already
 * issued token keeps working until its expiry (15 minutes, see
 * `ACCESS_TOKEN_EXPIRES_IN`); deleting the refresh token guarantees it
 * cannot be renewed. Checking the DB on every MCP request to close that
 * window was deliberately rejected as a hot-path cost.
 */
export const revokeOAuthClientAuthArtifacts = async (
  tx: Transaction,
  { userId, clientId, referenceId }: RevokeOAuthClientAuthArtifactsOptions,
): Promise<void> => {
  await tx
    .delete(oauthAccessToken)
    .where(
      and(
        eq(oauthAccessToken.userId, userId),
        eq(oauthAccessToken.clientId, clientId),
        referenceId
          ? eq(oauthAccessToken.referenceId, referenceId)
          : isNull(oauthAccessToken.referenceId),
      ),
    );

  await tx
    .delete(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        eq(oauthRefreshToken.clientId, clientId),
        referenceId
          ? eq(oauthRefreshToken.referenceId, referenceId)
          : isNull(oauthRefreshToken.referenceId),
      ),
    );
};
