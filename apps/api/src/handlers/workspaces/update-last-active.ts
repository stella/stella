import { and, eq } from "drizzle-orm";

import { db } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";

type UpdateLastActiveWorkspaceParams = {
  userId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

export const updateLastActiveWorkspaceHandler = async ({
  userId,
  organizationId,
  workspaceId,
}: UpdateLastActiveWorkspaceParams) => {
  await db
    .update(member)
    .set({ lastActiveWorkspaceId: workspaceId })
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
    );
};
