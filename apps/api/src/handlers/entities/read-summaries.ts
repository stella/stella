import { Result } from "better-result";
import { and, count, desc, eq, lt, or, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import {
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

const entityCreatedAtCursor = pgTimestampCursorValue(entities.createdAt);

const readEntitySummariesQuerySchema = t.Object({
  cursor: t.Optional(t.String()),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesWindowSizeMax,
    }),
  ),
});

type ReadEntitySummariesHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  cursor: string | undefined;
  limit: number;
};

const readEntitySummariesCountQuerySchema = t.Object({});

const parseSummaryCursor = (cursor: string | undefined) => {
  if (cursor === undefined) {
    return Result.ok(null);
  }

  const parts = decodePaginationCursor(cursor);
  const createdAt = parsePgTimestampCursorValue(parts?.at(0));
  const id = parts?.at(1);
  if (
    parts?.length !== 2 ||
    createdAt === null ||
    typeof id !== "string" ||
    !isUuid(id)
  ) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid cursor" }),
    );
  }

  return Result.ok({ createdAt, id });
};

const readEntitySummariesHandler = async function* ({
  safeDb,
  workspaceId,
  cursor,
  limit,
}: ReadEntitySummariesHandlerProps) {
  const cursorResult = parseSummaryCursor(cursor);
  if (Result.isError(cursorResult)) {
    return Result.err(cursorResult.error);
  }

  const cursorCondition =
    cursorResult.value === null
      ? undefined
      : or(
          lt(
            entities.createdAt,
            pgTimestampCursorBoundary(cursorResult.value.createdAt),
          ),
          and(
            eq(
              entities.createdAt,
              pgTimestampCursorBoundary(cursorResult.value.createdAt),
            ),
            sql`${entities.id} < ${cursorResult.value.id}`,
          ),
        );
  const whereClause = and(
    eq(entities.workspaceId, workspaceId),
    cursorCondition,
  );

  const rows = yield* await safeDb((tx) =>
    tx
      .select({
        id: entities.id,
        name: entities.name,
        createdAtCursor: entityCreatedAtCursor.as("created_at_cursor"),
      })
      .from(entities)
      .where(whereClause)
      .orderBy(desc(entities.createdAt), desc(entities.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([item.createdAtCursor, item.id]),
  });

  return Result.ok({
    ...page,
    items: page.items.map(({ id, name }) => ({ id, name })),
  });
};

const readEntitySummariesCountHandler = async function* ({
  safeDb,
  workspaceId,
}: {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
}) {
  const counts = yield* await safeDb((tx) =>
    tx
      .select({ total: count() })
      .from(entities)
      .where(eq(entities.workspaceId, workspaceId)),
  );

  return Result.ok({
    totalCount: counts.at(0)?.total ?? 0,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_documents" },
  query: readEntitySummariesQuerySchema,
} satisfies HandlerConfig;

const countConfig = {
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_documents" },
  query: readEntitySummariesCountQuerySchema,
} satisfies HandlerConfig;

const readEntitySummaries = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    return yield* readEntitySummariesHandler({
      safeDb,
      workspaceId,
      cursor: query.cursor,
      limit: query.limit ?? LIMITS.entitySummariesPageSize,
    });
  },
);

export const readEntitySummariesCount = createSafeHandler(
  countConfig,
  async function* ({ safeDb, workspaceId }) {
    return yield* readEntitySummariesCountHandler({ safeDb, workspaceId });
  },
);

export default readEntitySummaries;
