import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadLastActiveWorkspaceParams = {
  userId: string;
  organizationId: SafeId<"organization">;
};

export const readLastActiveWorkspaceHandler = async ({
  userId,
  organizationId,
}: ReadLastActiveWorkspaceParams) => {
  const result = await db.query.member.findFirst({
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
