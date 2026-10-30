import { Result } from "better-result";

import {
  createAuthDatabases,
  featureAccessSnapshotFromAuthorization,
  resolveCredentialMemberAuthorization,
} from "@/api/lib/auth";
import type { MemberAuthorizationLookup } from "@/api/lib/auth/member-authorization";
import { AGGREGATE_TRANSACTION_BUDGETS as BUDGETS } from "@/api/lib/db/aggregate-transaction-budget";
import { readAuthorizedWorkspaceExecutionAccess } from "@/api/lib/workspaces/authorized-workspace-ids";

/**
 * Rebuild authority after a chat approval pause. Execution transactions keep
 * their pin list empty so membership RLS remains live after this lookup.
 */
export const resolveCredentialMemberExecutionContext = async ({
  organizationId,
  userId,
}: MemberAuthorizationLookup) => {
  const authorization = await resolveCredentialMemberAuthorization({
    organizationId,
    userId,
  });
  if (authorization === null) {
    return Result.ok(null);
  }

  const featureAccessSnapshot = featureAccessSnapshotFromAuthorization({
    organizationId,
    userId,
    authorization,
  });
  const identity = {
    // Turn producers continue after their HTTP reader disconnects.
    budget: BUDGETS.scopedWorkerPendingMeasurement,
    organizationId,
    serverValidatedWorkspaceIds: [],
    userId,
  };
  const { safeDb, scopedDb } = createAuthDatabases(identity);
  const access = await scopedDb(
    async (tx) =>
      await readAuthorizedWorkspaceExecutionAccess(tx, { organizationId }),
  );
  return access.map((workspaceAccess) => ({
    ...workspaceAccess,
    featureAccessSnapshot,
    role: authorization.role,
    safeDb,
    scopedDb,
    userEmail: authorization.email,
  }));
};
