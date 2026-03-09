import { adminDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadLastActiveWorkspaceParams = {
  userId: string;
  organizationId: SafeId<"organization">;
};

// Uses adminDb because `member` is an org-level auth table
// with no RLS policy (not workspace-scoped).
export const readLastActiveWorkspaceHandler = async ({
  userId,
  organizationId,
}: ReadLastActiveWorkspaceParams) => {
  const result = await adminDb.query.member.findFirst({
    where: {
      userId,
      organizationId: { eq: organizationId },
    },
    columns: {
      lastActiveWorkspaceId: true,
    },
  });

  return {
    lastActiveWorkspaceId: result?.lastActiveWorkspaceId ?? null,
  };
};
