import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspaceMembersHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readWorkspaceMembersHandler = async ({
  scopedDb,
  workspaceId,
}: ReadWorkspaceMembersHandlerProps) => {
  return await scopedDb((tx) =>
    tx.query.workspaceMembers.findMany({
      where: { workspaceId: { eq: workspaceId } },
      limit: LIMITS.workspaceMembersCount,
      columns: {
        id: true,
        userId: true,
        createdAt: true,
      },
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    }),
  );
};
