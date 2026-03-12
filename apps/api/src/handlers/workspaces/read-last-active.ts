import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadLastActiveWorkspaceParams = {
  scopedDb: ScopedDb;
  userId: string;
  organizationId: SafeId<"organization">;
};

// `member` is an org-level auth table (no RLS policy);
// scopedDb works for querying it.
export const readLastActiveWorkspaceHandler = async ({
  scopedDb,
  userId,
  organizationId,
}: ReadLastActiveWorkspaceParams) => {
  const result = await scopedDb((tx) =>
    tx.query.member.findFirst({
      where: {
        userId,
        organizationId: { eq: organizationId },
      },
      columns: {
        lastActiveWorkspaceId: true,
      },
    }),
  );

  return {
    lastActiveWorkspaceId: result?.lastActiveWorkspaceId ?? null,
  };
};
