import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import {
  entities,
  entityVersions,
  legalListItemSources,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { parseLegalListSourceLocator } from "@/api/lib/lists/source-locator";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
  sourceEntityId: tSafeId("entity"),
  sourceEntityVersionId: tSafeId("entityVersion"),
  locator: t.Union([
    t.Object({ type: t.Literal("document") }),
    t.Object({
      type: t.Literal("docx-block"),
      blockId: t.String({ minLength: 1, maxLength: 512 }),
    }),
    t.Object({
      type: t.Literal("pdf-page"),
      pageNumber: t.Integer({ minimum: 1 }),
    }),
  ]),
  quote: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

const config = {
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: bodySchema,
} satisfies HandlerConfig;

const createItemSource = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const locator = parseLegalListSourceLocator(body.locator);
    if (!locator.success) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid source locator" }),
      );
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const item = await tx.query.legalListItems.findFirst({
          where: {
            entityId: { eq: body.itemEntityId },
            listId: { eq: body.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { entityId: true },
        });
        const source = await tx
          .select({ id: entityVersions.id })
          .from(entityVersions)
          .innerJoin(
            entities,
            and(
              eq(entities.id, entityVersions.entityId),
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "document"),
            ),
          )
          .where(
            and(
              eq(entityVersions.id, body.sourceEntityVersionId),
              eq(entityVersions.entityId, body.sourceEntityId),
              isNull(entityVersions.deletedAt),
            ),
          )
          .limit(1);
        if (!item || !source.at(0)) {
          return null;
        }

        const id = createSafeId<"legalListItemSource">();
        const sourceValues = {
          id,
          workspaceId,
          listId: body.listId,
          itemEntityId: body.itemEntityId,
          sourceEntityId: body.sourceEntityId,
          sourceEntityVersionId: body.sourceEntityVersionId,
          locator: locator.output,
          quote: body.quote ?? null,
          createdBy: user.id,
        } satisfies typeof legalListItemSources.$inferInsert;
        await tx.insert(legalListItemSources).values(sourceValues);
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          resourceId: body.itemEntityId,
          metadata: { operation: "source_added", sourceId: id },
        });
        return id;
      }),
    );

    if (!result) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "List item or source not found",
        }),
      );
    }
    return Result.ok({ id: result });
  },
);

export default createItemSource;
