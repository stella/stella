import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import {
  oauthAccessToken,
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
   * The consent's organization scope. When set, only tokens issued for
   * that organization are revoked; `null` revokes the client's tokens
   * regardless of organization (an org-unscoped grant).
   */
  referenceId: string | null;
};

/**
 * Revokes every OAuth token one client holds for one user (per-consent
 * disconnect from the connections settings page). Unlike
 * `revokeOrganizationMemberAuthArtifacts` this must NOT touch `session`
 * rows: disconnecting an OAuth app ends that app's access, not the
 * user's own web sessions.
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
        referenceId ? eq(oauthAccessToken.referenceId, referenceId) : undefined,
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
          : undefined,
      ),
    );
};
