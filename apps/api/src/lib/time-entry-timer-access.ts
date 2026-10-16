import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMemberAccessRow,
  lockMatterAccessWorkspaceRows,
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
  // Freeze membership before the matter: role changes already hold the member
  // row, and their guards can then take the matter without an inverted wait.
  const member = await lockMemberAccessRow({
    tx,
    organizationId,
    userId,
    mode: "share",
  });
  if (member === undefined) {
    return false;
  }
  // Assignment-loss guards lock the matter FOR UPDATE, so this one lock
  // also serializes revocation without locking an assignment after its matter.
  const matters = await lockMatterAccessWorkspaceRows({
    tx,
    organizationId,
    workspaceIds: [workspaceId],
    mode: "share",
    where: eq(workspaces.status, "active"),
  });
  if (matters.length === 0) {
    return false;
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
