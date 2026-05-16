import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db";
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
};
