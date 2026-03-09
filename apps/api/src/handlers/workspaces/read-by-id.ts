import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspaceHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
};

export const readWorkspaceHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
}: ReadWorkspaceHandlerProps) => {
  const result = await scopedDb((tx) =>
    tx.query.workspaces.findFirst({
      where: {
        id: workspaceId,
      },
      with: {
        client: {
          columns: {
            id: true,
            type: true,
            displayName: true,
            color: true,
          },
        },
      },
    }),
  );

  if (!result) {
    return status(404);
  }

  if (result.organizationId !== organizationId) {
    return status(403);
  }

  return { ...result, limits: LIMITS };
};
