import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { WORKSPACE_STATUS } from "@stll/api-contract/workspace-status";

import { workspaces } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMatterAccessAssignments,
  lockTimerMatterAccessRows,
  lockWorkspaceLifecycle,
  TIMER_MATTER_LOCK_SCOPE,
} from "@/api/lib/db/aggregate-lock";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";
import { roleReachesMatterSql } from "@/api/lib/workspaces/matter-visibility";

export const hasCurrentTimerMatterAccess = async ({
  organizationId,
  tx,
  userId,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): Promise<boolean> => {
  await lockWorkspaceLifecycle(tx, workspaceId);
  // This predicate only chooses the timer's lock scope: a matter the
  // member's role reaches through its visibility needs no assignment lock.
  // The later database rule is the access decision.
  const rows = sql`CASE
    WHEN ${roleReachesMatterSql(sql`organization_member.role`, {
      visibility: sql`workspace.visibility`,
      clientId: sql`workspace.client_id`,
    })} THEN ${TIMER_MATTER_LOCK_SCOPE.role}
    WHEN EXISTS (
      SELECT 1 FROM workspace_members AS workspace_member
      WHERE workspace_member.workspace_id = workspace.id
        AND workspace_member.user_id = ${userId}
    ) THEN ${TIMER_MATTER_LOCK_SCOPE.assignment}
    ELSE NULL
  END`;
  const lockScope = await lockTimerMatterAccessRows({
    tx,
    organizationId,
    userId,
    workspaceId,
    lockScope: rows,
  });
  switch (lockScope) {
    case null:
      return false;
    case TIMER_MATTER_LOCK_SCOPE.assignment:
      await lockMatterAccessAssignments({
        tx,
        organizationId,
        userId,
        workspaceIds: [workspaceId],
        mode: "share",
      });
      break;
    case TIMER_MATTER_LOCK_SCOPE.role:
      break;
    default:
      lockScope satisfies never;
      return panic("Unknown timer matter lock scope");
  }
  const reachableRows = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.status, WORKSPACE_STATUS.active),
        memberReachesMatterSql({ organizationId, userId }, workspaces.id),
      ),
    )
    .limit(1);
  return reachableRows.length === 1;
};
