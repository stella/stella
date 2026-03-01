import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadViewsHandlerProps = {
  workspaceId: SafeId<"workspace">;
};

export const readViewsHandler = ({ workspaceId }: ReadViewsHandlerProps) => {
  return db.query.views.findMany({
    where: {
      workspaceId,
    },
    orderBy: (views, { asc }) => [asc(views.position), asc(views.createdAt)],
  });
};
