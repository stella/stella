import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, fields } from "@/api/db/schema";
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

const listFilesQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.entitiesWindowSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});
type ListFilesQuery = (typeof listFilesQuerySchema)["static"];

type ListFilesHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  query: ListFilesQuery;
};

const listFilesHandler = async function* ({
  query,
  safeDb,
  workspaceId,
}: ListFilesHandlerProps) {
  const limit = query.limit ?? LIMITS.entitiesWindowSizeDefault;
  const cursor = decodeEntityListCursor(query.cursor);
  const cursorCondition = entityListCursorCondition(cursor);
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          createdAt: entities.createdAt,
          entityId: entities.id,
          name: entities.name,
          parentId: entities.parentId,
          fieldContent: fields.content,
        })
        .from(entities)
        .innerJoin(
          fields,
          and(
            eq(fields.entityVersionId, entities.currentVersionId),
            eq(fields.workspaceId, workspaceId),
            sql`${fields.content}->>'type' = 'file'`,
          ),
        )
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            eq(entities.kind, "document"),
            ...(cursorCondition ? [cursorCondition] : []),
          ),
        )
        .orderBy(asc(entities.createdAt), asc(entities.id))
        .limit(limit + 1),
    ),
  );

  type FileRow = {
    entityId: SafeId<"entity">;
    name: string | null;
    parentId: SafeId<"entity"> | null;
    fileName: string;
    mimeType: string;
  };

  const files: (FileRow & { createdAt: Date })[] = [];
  for (const row of rows) {
    const content = row.fieldContent;
    if (content.type !== "file") {
      continue;
    }
    files.push({
      entityId: row.entityId,
      name: row.name,
      parentId: row.parentId,
      createdAt: row.createdAt,
      fileName: content.fileName,
      mimeType: content.mimeType,
    });
  }

  const page = createCursorPage({
    rows: files,
    limit,
    cursorForItem: (item) =>
      encodeEntityListCursor({ createdAt: item.createdAt, id: item.entityId }),
  });

  return Result.ok({
    ...page,
    items: page.items.map(({ createdAt: _createdAt, ...file }) => file),
  });
};

const config = {
  permissions: { workspace: ["read"] },
  query: listFilesQuerySchema,
} satisfies HandlerConfig;

const listFiles = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    return yield* listFilesHandler({ query, safeDb, workspaceId });
  },
);

export default listFiles;
