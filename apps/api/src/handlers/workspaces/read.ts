import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspacesHandlerProps = {
  organizationId: SafeId<"organization">;
};

export const readWorkspacesHandler = async ({
  organizationId,
}: ReadWorkspacesHandlerProps) => {
  const result = await db.query.workspaces.findMany({
    where: {
      organizationId,
      status: "active",
    },
    columns: {
      id: true,
      name: true,
      reference: true,
      clientId: true,
      color: true,
      status: true,
      createdAt: true,
    },
    with: {
      client: {
        columns: {
          id: true,
          displayName: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    limit: LIMITS.workspacesCount,
  });

  return { workspaces: result, workspacesCountLimit: LIMITS.workspacesCount };
};
