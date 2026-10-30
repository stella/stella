import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMatterAccessAssignments,
  lockTimerMatterAccessRows,
  lockWorkspaceLifecycle,
  TIMER_MATTER_LOCK_SCOPE,
} from "@/api/lib/db/aggregate-lock";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";

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
  // This predicate only preserves the timer's original lock scope, including
  // its client-admin assignment-lock exemption. The later database rule is
  // the access decision.
  const rows = sql`CASE
    WHEN organization_member.role IN (${sql.join(
      CLIENT_MATTER_ADMIN_ROLES.map((role) => sql`${role}`),
      sql`, `,
    )}) AND workspace.client_id IS NOT NULL THEN ${TIMER_MATTER_LOCK_SCOPE.client}
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
    case TIMER_MATTER_LOCK_SCOPE.client:
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
        eq(workspaces.status, "active"),
        memberReachesMatterSql({ organizationId, userId }, workspaces.id),
      ),
    )
    .limit(1);
  return reachableRows.length === 1;
};
