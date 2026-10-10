import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import { legalListColumns, legalListItems, properties } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIMITS } from "@/api/lib/limits";
import { LIST_COLUMN_OVERFLOW_ERROR_CODE } from "@/api/lib/lists/column-error-codes";

const paramsSchema = workspaceParams({ listId: tSafeId("legalList") });

const config = {
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "Read one list with its sections in order, its columns (each bound " +
    "property with its position and required flag), and how many items it " +
    "holds. The items themselves come from lists.items.list.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: paramsSchema,
} satisfies WorkspaceHandlerConfig;

const readListById = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const list = await tx.query.legalLists.findFirst({
          where: {
            id: { eq: params.listId },
            workspaceId: { eq: workspaceId },
          },
        });
        if (!list) {
          return null;
        }

        const [sections, columns, itemCount] = await Promise.all([
          tx.query.legalListSections.findMany({
            where: {
              workspaceId: { eq: workspaceId },
              listId: { eq: params.listId },
            },
            orderBy: { position: "asc", id: "asc" },
            limit: LIMITS.legalListSectionsPerList,
          }),
          readBounded(
            tx
              .select({
                id: legalListColumns.id,
                propertyId: legalListColumns.propertyId,
                position: legalListColumns.position,
                required: legalListColumns.required,
                name: properties.name,
              })
              .from(legalListColumns)
              .innerJoin(
                properties,
                and(
                  eq(properties.id, legalListColumns.propertyId),
                  eq(properties.workspaceId, workspaceId),
                ),
              )
              .where(
                and(
                  eq(legalListColumns.workspaceId, workspaceId),
                  eq(legalListColumns.listId, params.listId),
                ),
              )
              .orderBy(
                asc(legalListColumns.position),
                asc(legalListColumns.id),
              ),
            LIMITS.legalListColumnsPerList,
          ),
          tx.$count(
            legalListItems,
            and(
              eq(legalListItems.workspaceId, workspaceId),
              eq(legalListItems.listId, params.listId),
            ),
          ),
        ]);

        return { list, sections, columns, itemCount };
      }),
    );

    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "List not found" }),
      );
    }

    if (result.columns.type === "overflow") {
      return Result.err(
        new HandlerError({
          status: 409,
          code: LIST_COLUMN_OVERFLOW_ERROR_CODE,
          message: "List column count exceeds the supported limit",
          hint: "Review the stored list columns before retrying lists.get; no columns have been removed.",
        }),
      );
    }

    return Result.ok({
      id: result.list.id,
      name: result.list.name,
      description: result.list.description,
      status: result.list.status,
      createdAt: result.list.createdAt,
      updatedAt: result.list.updatedAt,
      itemCount: result.itemCount,
      sections: result.sections,
      columns: result.columns.rows,
    });
  },
);

export default readListById;
