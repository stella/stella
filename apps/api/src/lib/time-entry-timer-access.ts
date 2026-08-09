import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

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
  const [access] = await tx
    .select({
      clientId: workspaces.clientId,
      organizationRole: member.role,
      workspaceMemberId: workspaceMembers.id,
    })
    .from(workspaces)
    .leftJoin(
      member,
      and(
        eq(member.organizationId, workspaces.organizationId),
        eq(member.userId, userId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.status, "active"),
      ),
    )
    .limit(1);
  if (!access || access.organizationRole === null) {
    return false;
  }
  const hasAdminBypass =
    (access.organizationRole === "owner" ||
      access.organizationRole === "admin") &&
    access.clientId !== null;
  return access.workspaceMemberId !== null || hasAdminBypass;
};
