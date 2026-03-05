import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspaceContactsHandlerProps = {
  workspaceId: SafeId<"workspace">;
};

export const readWorkspaceContactsHandler = async ({
  workspaceId,
}: ReadWorkspaceContactsHandlerProps) => {
  return await db.query.workspaceContacts.findMany({
    where: { workspaceId: { eq: workspaceId } },
    limit: LIMITS.workspaceContactsCount,
    with: {
      contact: {
        columns: {
          id: true,
          type: true,
          displayName: true,
          color: true,
        },
      },
    },
  });
};
