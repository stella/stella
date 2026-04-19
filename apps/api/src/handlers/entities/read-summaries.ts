import { Result } from "better-result";
import { count, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

const readEntitySummariesQuerySchema = t.Object({
  page: t.Optional(t.Integer({ minimum: 1 })),
});

type ReadEntitySummariesHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  page: number;
};

const readEntitySummariesHandler = async function* ({
  safeDb,
  workspaceId,
  page,
}: ReadEntitySummariesHandlerProps) {
  const pageSize = LIMITS.entitySummariesPageSize;
  const offset = (page - 1) * pageSize;
  const whereClause = eq(entities.workspaceId, workspaceId);

  const [rowsResult, countResult] = await Promise.all([
    safeDb((tx) =>
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
    safeDb((tx) =>
      tx.select({ total: count() }).from(entities).where(whereClause),
    ),
  ]);

  const rows = yield* rowsResult;
  const counts = yield* countResult;

  return Result.ok({
    summaries: rows,
    totalCount: counts.at(0)?.total ?? 0,
    page,
    pageSize,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  query: readEntitySummariesQuerySchema,
} satisfies HandlerConfig;

const readEntitySummaries = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    return yield* readEntitySummariesHandler({
      safeDb,
      workspaceId,
      page: query.page ?? 1,
    });
  },
);

export default readEntitySummaries;
