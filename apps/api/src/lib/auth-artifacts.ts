import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { agentDelegation, agentRegistration } from "@/api/db/agent-auth-schema";
import {
  oauthAccessToken,
  oauthRefreshToken,
  session as sessionTable,
} from "@/api/db/auth-schema";

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

  // auth.md agent registrations/delegations bound to this member in this org:
  // their access tokens are already gone above; drop the ceremony state and
  // the (iss,sub) delegation so a re-added member never inherits a stale link.
  await tx
    .delete(agentRegistration)
    .where(
      and(
        eq(agentRegistration.boundUserId, userId),
        eq(agentRegistration.boundOrganizationId, organizationId),
      ),
    );

  await tx
    .delete(agentDelegation)
    .where(
      and(
        eq(agentDelegation.userId, userId),
        eq(agentDelegation.organizationId, organizationId),
      ),
    );
};
