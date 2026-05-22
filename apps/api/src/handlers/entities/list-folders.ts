import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import {
  decodeEntityListCursor,
  encodeEntityListCursor,
  entityListCursorCondition,
} from "@/api/handlers/entities/list-cursor";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";

const listFoldersQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.entitiesWindowSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});
type ListFoldersQuery = (typeof listFoldersQuerySchema)["static"];

type ListFoldersHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  query: ListFoldersQuery;
};

const listFoldersHandler = async function* ({
  query,
  safeDb,
  workspaceId,
}: ListFoldersHandlerProps) {
  const limit = query.limit ?? LIMITS.entitiesWindowSizeDefault;
  const cursor = decodeEntityListCursor(query.cursor);
  const cursorCondition = entityListCursorCondition(cursor);
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          createdAt: entities.createdAt,
          id: entities.id,
          name: entities.name,
          parentId: entities.parentId,
        })
        .from(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            eq(entities.kind, "folder"),
            ...(cursorCondition ? [cursorCondition] : []),
          ),
        )
        .orderBy(asc(entities.createdAt), asc(entities.id))
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodeEntityListCursor({ createdAt: item.createdAt, id: item.id }),
  });

  return Result.ok({
    ...page,
    items: page.items.map(({ createdAt: _createdAt, ...folder }) => folder),
  });
};

const config = {
  permissions: { workspace: ["read"] },
  query: listFoldersQuerySchema,
} satisfies HandlerConfig;

const listFolders = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    return yield* listFoldersHandler({ query, safeDb, workspaceId });
  },
);

export default listFolders;
