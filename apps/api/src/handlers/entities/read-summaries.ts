import { count, desc, eq } from "drizzle-orm";

import { db } from "@/api/db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadEntitySummariesHandlerProps = {
  workspaceId: SafeId<"workspace">;
  page: number;
};

export const readEntitySummariesHandler = async ({
  workspaceId,
  page,
}: ReadEntitySummariesHandlerProps) => {
  const pageSize = LIMITS.entitySummariesPageSize;
  const offset = (page - 1) * pageSize;
  const whereClause = eq(entities.workspaceId, workspaceId);

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: entities.id,
        name: entities.name,
      })
      .from(entities)
      .where(whereClause)
      .orderBy(desc(entities.createdAt))
      .offset(offset)
      .limit(pageSize),
    db.select({ total: count() }).from(entities).where(whereClause),
  ]);

  return {
    summaries: rows,
    totalCount: countResult.at(0)?.total ?? 0,
    page,
    pageSize,
  };
};
