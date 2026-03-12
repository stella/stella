import { and, eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";

type UpdateLastActiveWorkspaceParams = {
  scopedDb: ScopedDb;
  userId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

// `member` is an org-level auth table (no RLS policy);
// scopedDb works for querying it.
export const updateLastActiveWorkspaceHandler = async ({
  scopedDb,
  userId,
  organizationId,
  workspaceId,
}: UpdateLastActiveWorkspaceParams) => {
  await scopedDb((tx) =>
    tx
      .update(member)
      .set({ lastActiveWorkspaceId: workspaceId })
      .where(
        and(
          eq(member.userId, userId),
          eq(member.organizationId, organizationId),
        ),
      ),
  );
};
