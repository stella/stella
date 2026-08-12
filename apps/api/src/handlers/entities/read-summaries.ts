import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

const entityCreatedAtCursor = createTimestampIdCursorCodec({
  column: entities.createdAt,
  brandId: brandPersistedEntityId,
});

const readEntitySummariesQuerySchema = t.Object({
  cursor: t.Optional(tPaginationCursor()),
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

const parseSummaryCursor = (cursor: string | undefined) => {
  if (cursor === undefined) {
    return Result.ok(null);
  }

  const decoded = entityCreatedAtCursor.decode(cursor);
  if (decoded === null) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid cursor" }),
    );
  }

  return Result.ok(decoded);
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
      : entityCreatedAtCursor.keysetAfter({
          cursor: cursorResult.value,
          direction: "descending",
          idColumn: entities.id,
        });
  const whereClause = and(
    eq(entities.workspaceId, workspaceId),
    cursorCondition,
  );

  const rows = yield* await safeDb((tx) =>
    tx
      .select({
        id: entities.id,
        name: entities.name,
        createdAtCursor:
          entityCreatedAtCursor.cursorValue.as("created_at_cursor"),
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
      entityCreatedAtCursor.encode(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    items: page.items.map(({ id, name }) => ({ id, name })),
  });
};

const config = {
  description:
    "List a matter's documents, folders, and tasks as bare id and name " +
    "pairs, newest first with cursor pagination. The cheapest listing " +
    "available: no column values, no file metadata, no filters. Use " +
    "entities.read-summaries-count for the total and entities.list when you " +
    "need column values or filtering.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_documents" },
  access: "read",
  query: readEntitySummariesQuerySchema,
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

export default readEntitySummaries;
