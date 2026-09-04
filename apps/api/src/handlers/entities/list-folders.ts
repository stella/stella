import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import {
  decodeEntityListCursor,
  encodeEntityListCursor,
  entityListTimestampCursorExpr,
  entityListCursorCondition,
} from "@/api/lib/entities/list-cursor";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";

const listFoldersQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.entitiesWindowSizeMax }),
  ),
  cursor: t.Optional(tPaginationCursor()),
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
          createdAt: entityListTimestampCursorExpr(sql`${entities.createdAt}`),
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
  description:
    "List the folders of a matter, oldest first with cursor pagination, each " +
    "with its id, name, and parent folder. Documents and tasks are left out; " +
    "use entities.read-filesystem-tree for the folder tree with the " +
    "documents in it.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_documents" },
  access: "read",
  query: listFoldersQuerySchema,
} satisfies HandlerConfig;

const listFolders = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    return yield* listFoldersHandler({ query, safeDb, workspaceId });
  },
);

export default listFolders;
