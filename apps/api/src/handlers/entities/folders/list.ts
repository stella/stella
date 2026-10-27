import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { entityContextId } from "@/api/db/entity-feature-policies";
import type { SafeDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import {
  decodeEntityListCursor,
  encodeEntityListCursor,
  entityListCursorCondition,
  entityListTimestampCursorExpr,
} from "@/api/lib/entities/list-cursor";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const listFoldersQuerySchema = v.object({
  limit: v.optional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.entitiesWindowSizeMax),
      ),
    ),
  ),
  cursor: v.optional(paginationCursorSchema()),
});
type ListFoldersQuery = v.InferOutput<typeof listFoldersQuerySchema>;

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
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.entitiesWindowSizeDefault,
  );
  const cursor = decodeEntityListCursor(query.cursor);
  const cursorCondition = entityListCursorCondition(cursor);
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          createdAt: entityListTimestampCursorExpr(sql`${entities.createdAt}`),
          id: entities.id,
          name: entities.name,
          parentId: entityContextId(entities.parentId),
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
  contract: "patch",
  description:
    "List the folders of a matter, oldest first with cursor pagination, each " +
    "with its id, name, and parent folder. Documents and tasks are left out; " +
    "use entities.filesystem-tree.get for the folder tree with the " +
    "documents in it.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "list_documents" },
  access: "read",
  query: listFoldersQuerySchema,
} satisfies WorkspaceHandlerConfig;

const listFolders = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    return yield* listFoldersHandler({ query, safeDb, workspaceId });
  },
);

export default listFolders;
