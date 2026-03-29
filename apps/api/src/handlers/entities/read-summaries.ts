import { count, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

export const readEntitySummariesQuerySchema = t.Object({
  page: t.Optional(t.Integer({ minimum: 1 })),
});

type ReadEntitySummariesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  page: number;
};

export const readEntitySummariesHandler = async ({
  scopedDb,
  workspaceId,
  page,
}: ReadEntitySummariesHandlerProps) => {
  const pageSize = LIMITS.entitySummariesPageSize;
  const offset = (page - 1) * pageSize;
  const whereClause = eq(entities.workspaceId, workspaceId);

  const [rows, countResult] = await Promise.all([
    scopedDb((tx) =>
      tx
        .select({
          id: entities.id,
          name: entities.name,
        })
        .from(entities)
        .where(whereClause)
        .orderBy(desc(entities.createdAt))
        .offset(offset)
        .limit(pageSize),
    ),
    scopedDb((tx) =>
      tx.select({ total: count() }).from(entities).where(whereClause),
    ),
  ]);

  return {
    summaries: rows,
    totalCount: countResult.at(0)?.total ?? 0,
    page,
    pageSize,
  };
};

const config = {
  permissions: { workspace: ["read"] },
  query: readEntitySummariesQuerySchema,
} satisfies HandlerConfig;

const readEntitySummaries = createHandler(
  config,
  async ({ scopedDb, workspaceId, query }) =>
    await readEntitySummariesHandler({
      scopedDb,
      workspaceId,
      page: query.page ?? 1,
    }),
);

export default readEntitySummaries;
