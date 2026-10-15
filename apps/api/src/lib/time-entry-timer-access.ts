import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMatterAccessAssignments,
  lockMatterAccessWorkspaceRows,
  lockMemberAccessRow,
  lockWorkspaceLifecycle,
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
  const scope = { tx, organizationId, userId, mode: "share" } as const;
  const member = await lockMemberAccessRow(scope);
  if (member === undefined) {
    return false;
  }
  await lockMatterAccessAssignments({ ...scope, workspaceIds: [workspaceId] });
  await lockMatterAccessWorkspaceRows({
    ...scope,
    workspaceIds: [workspaceId],
  });
  const rows = await tx
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
  return rows.length === 1;
};
