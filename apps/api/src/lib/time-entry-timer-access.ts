import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
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
  await lockMatterStewardship({
    tx,
    requests: [
      { organizationId, workspaceIds: [workspaceId], userIds: [userId] },
    ],
    mode: "share",
  });
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
