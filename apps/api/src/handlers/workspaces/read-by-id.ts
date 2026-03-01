import { status } from "elysia";

import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspaceHandlerProps = {
  workspaceId: string;
  organizationId: SafeId<"organization">;
};

export const readWorkspaceHandler = async ({
  workspaceId,
  organizationId,
}: ReadWorkspaceHandlerProps) => {
  const result = await db.query.workspaces.findFirst({
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
  });

  if (!result) {
    return status(404);
  }

  if (result.organizationId !== organizationId) {
    return status(403);
  }

  return { ...result, limits: LIMITS };
};
