import { Result } from "better-result";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { t } from "elysia";

import {
  entities,
  fields,
  legalListColumns,
  legalListItems,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

const paramsSchema = t.Object({ listId: tSafeId("legalList") });
const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.legalListItemsPageSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  params: paramsSchema,
  query: querySchema,
} satisfies HandlerConfig;

type ItemCursor = { position: string; id: SafeId<"entity"> };

const decodeCursor = (value: string): ItemCursor | null => {
  const parts = decodePaginationCursor(value);
  const position = parts?.at(0);
  const id = parts?.at(1);
  if (typeof position !== "string" || !isUuidPaginationCursorPart(id)) {
    return null;
  }
  return { position, id: brandPersistedEntityId(id) };
};

const readListItems = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, query }) {
    const limit = query.limit ?? LIMITS.legalListItemsPageSizeDefault;
    const conditions = [
      eq(legalListItems.workspaceId, workspaceId),
      eq(legalListItems.listId, params.listId),
    ];

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = or(
        gt(legalListItems.position, cursor.position),
        and(
          eq(legalListItems.position, cursor.position),
          gt(legalListItems.entityId, cursor.id),
        ),
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const list = await tx.query.legalLists.findFirst({
          where: {
            id: { eq: params.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        });
        if (!list) {
          return null;
        }

        const [rows, columns] = await Promise.all([
          tx
            .select({
              id: entities.id,
              name: entities.name,
              itemType: entities.listItemType,
              status: entities.status,
              priority: entities.priority,
              dueDate: entities.dueDate,
              sectionId: legalListItems.sectionId,
              position: legalListItems.position,
              description: legalListItems.description,
              reviewStatus: legalListItems.reviewStatus,
              createdAt: legalListItems.createdAt,
              updatedAt: legalListItems.updatedAt,
            })
            .from(legalListItems)
            .innerJoin(
              entities,
              and(
                eq(entities.id, legalListItems.entityId),
                eq(entities.workspaceId, workspaceId),
                eq(entities.kind, "task"),
              ),
            )
            .where(and(...conditions))
            .orderBy(asc(legalListItems.position), asc(legalListItems.entityId))
            .limit(limit + 1),
          tx
            .select({ propertyId: legalListColumns.propertyId })
            .from(legalListColumns)
            .where(
              and(
                eq(legalListColumns.workspaceId, workspaceId),
                eq(legalListColumns.listId, params.listId),
              ),
            )
            .orderBy(asc(legalListColumns.position))
            .limit(LIMITS.legalListColumnsPerList),
        ]);
        const entityIds = rows.map((row) => row.id);
        const propertyIds = columns.map((column) => column.propertyId);
        if (entityIds.length === 0 || propertyIds.length === 0) {
          return rows.map((row) => Object.assign(row, { customFields: [] }));
        }
        const fieldRows = await tx
          .select({
            entityId: entities.id,
            propertyId: fields.propertyId,
            content: fields.content,
          })
          .from(fields)
          .innerJoin(
            entities,
            and(
              eq(entities.currentVersionId, fields.entityVersionId),
              eq(entities.workspaceId, workspaceId),
              inArray(entities.id, entityIds),
            ),
          )
          .where(
            and(
              eq(fields.workspaceId, workspaceId),
              inArray(fields.propertyId, propertyIds),
            ),
          );
        const fieldsByEntity = new Map<string, typeof fieldRows>();
        for (const field of fieldRows) {
          const entityFields = fieldsByEntity.get(field.entityId) ?? [];
          entityFields.push(field);
          fieldsByEntity.set(field.entityId, entityFields);
        }
        return rows.map((row) =>
          Object.assign(row, {
            customFields: fieldsByEntity.get(row.id) ?? [],
          }),
        );
      }),
    );

    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "List not found" }),
      );
    }

    return Result.ok(
      createCursorPage({
        rows: result,
        limit,
        cursorForItem: (item) =>
          encodePaginationCursor([item.position, item.id]),
      }),
    );
  },
);

export default readListItems;
