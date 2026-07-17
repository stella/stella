import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import { legalListColumns, legalListItems, properties } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const paramsSchema = t.Object({ listId: tSafeId("legalList") });

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  params: paramsSchema,
} satisfies HandlerConfig;

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
            .orderBy(asc(legalListColumns.position), asc(legalListColumns.id))
            .limit(LIMITS.legalListColumnsPerList),
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

    return Result.ok({
      id: result.list.id,
      name: result.list.name,
      description: result.list.description,
      status: result.list.status,
      createdAt: result.list.createdAt,
      updatedAt: result.list.updatedAt,
      itemCount: result.itemCount,
      sections: result.sections,
      columns: result.columns,
    });
  },
);

export default readListById;
