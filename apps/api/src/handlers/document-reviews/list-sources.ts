import { Result } from "better-result";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, fields } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import {
  decodeEntityFileListCursor,
  encodeEntityFileListCursor,
  entityFileListCursorCondition,
  entityListTimestampCursorExpr,
} from "@/api/lib/entities/list-cursor";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/** Bounded reference-document picker page size. */
const SOURCES_PAGE_SIZE_DEFAULT = 20;
const SOURCES_PAGE_SIZE_MAX = 50;

const listSourcesQuerySchema = t.Object({
  q: t.Optional(t.String({ maxLength: LIMITS.entityNameMaxLength })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: SOURCES_PAGE_SIZE_MAX,
    }),
  ),
  cursor: t.Optional(tPaginationCursor()),
});
type ListSourcesQuery = (typeof listSourcesQuerySchema)["static"];

type ListSourcesArgs = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  query: ListSourcesQuery;
};

const listSourcesHandler = async function* ({
  safeDb,
  workspaceId,
  query,
}: ListSourcesArgs) {
  const limit = query.limit ?? SOURCES_PAGE_SIZE_DEFAULT;
  const search = query.q?.trim() ?? "";
  const cursor = decodeEntityFileListCursor(query.cursor);
  const cursorCondition = entityFileListCursorCondition(cursor);
  const nameCondition =
    search.length === 0
      ? undefined
      : or(
          ilike(entities.name, `${escapeLike(search)}%`),
          ilike(entities.displayName, `${escapeLike(search)}%`),
        );

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          createdAt: entityListTimestampCursorExpr(sql`${entities.createdAt}`),
          entityId: entities.id,
          fileFieldId: fields.id,
          name: entities.name,
          fieldContent: fields.content,
        })
        .from(entities)
        .innerJoin(
          fields,
          and(
            eq(fields.entityVersionId, entities.currentVersionId),
            eq(fields.workspaceId, workspaceId),
            sql`${fields.content}->>'type' = 'file'`,
            sql`${fields.content}->>'mimeType' = ${DOCX_MIME_TYPE}`,
          ),
        )
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            eq(entities.kind, "document"),
            nameCondition,
            cursorCondition,
          ),
        )
        .orderBy(asc(entities.createdAt), asc(entities.id), asc(fields.id))
        .limit(limit + 1),
    ),
  );

  const sources: {
    createdAt: string;
    entityId: SafeId<"entity">;
    fileFieldId: SafeId<"field">;
    name: string;
    fileName: string;
  }[] = [];
  for (const row of rows) {
    const content = row.fieldContent;
    if (content.type !== "file" || content.mimeType !== DOCX_MIME_TYPE) {
      continue;
    }
    sources.push({
      createdAt: row.createdAt,
      entityId: row.entityId,
      fileFieldId: row.fileFieldId,
      name: row.name,
      fileName: content.fileName,
    });
  }

  const page = createCursorPage({
    rows: sources,
    limit,
    cursorForItem: (item) =>
      encodeEntityFileListCursor({
        createdAt: item.createdAt,
        fieldId: item.fileFieldId,
        id: item.entityId,
      }),
  });

  return Result.ok({
    ...page,
    items: page.items.map(({ createdAt: _createdAt, ...source }) => source),
  });
};

const config = {
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  query: listSourcesQuerySchema,
} satisfies HandlerConfig;

const listDocumentReviewSources = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    return yield* listSourcesHandler({ query, safeDb, workspaceId });
  },
);

export default listDocumentReviewSources;
