import { and, eq } from "drizzle-orm";

import { adminDb } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";

type UpdateLastActiveWorkspaceParams = {
  userId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

// Uses adminDb because `member` is an org-level auth table
// with no RLS policy (not workspace-scoped).
export const updateLastActiveWorkspaceHandler = async ({
  userId,
  organizationId,
  workspaceId,
}: UpdateLastActiveWorkspaceParams) => {
  await adminDb
    .update(member)
    .set({ lastActiveWorkspaceId: workspaceId })
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
    );
};
