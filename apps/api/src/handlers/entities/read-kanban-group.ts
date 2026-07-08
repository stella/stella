import { panic, Result } from "better-result";
import { t } from "elysia";

import {
  buildKanbanGroupCondition,
  tGroupByPropertyId,
} from "@/api/handlers/entities/kanban-group-condition";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/handlers/entities/window-cursor";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { tViewSortSchema } from "@/api/lib/views-schema";

const readKanbanGroupBodySchema = t.Object({
  filters: t.Optional(t.Array(tConditionNode)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesWindowSizeMax,
    }),
  ),
  cursor: t.Optional(t.String()),
  fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
  // Document-table grouping passes ["folder", "task"] to match the flat window
  // query; the kanban board omits it so status columns keep their tasks.
  excludedKinds: t.Optional(
    t.Array(t.UnionEnum(["document", "folder", "task", "message", "link"]), {
      maxItems: 5,
    }),
  ),
  groupByPropertyId: tGroupByPropertyId,
  groupValue: t.Nullable(t.String({ maxLength: 1000 })),
  // The property's current option values. When sent (grouped table), the
  // uncategorized bucket folds in cells whose value is no longer an option;
  // omitted (kanban board) keeps "no non-empty value".
  optionValues: t.Optional(t.Array(t.String({ maxLength: 1000 }))),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "pending" },
  body: readKanbanGroupBodySchema,
} satisfies HandlerConfig;

const readKanbanGroup = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, body, user: currentUser }) {
    const cursorResult = decodeEntitiesWindowCursor(body.cursor);
    if (Result.isError(cursorResult)) {
      return Result.err(cursorResult.error);
    }

    const conditionResult = buildKanbanGroupCondition({
      groupByPropertyId: body.groupByPropertyId,
      groupValue: body.groupValue,
      optionValues: body.optionValues,
    });
    if (Result.isError(conditionResult)) {
      return Result.err(conditionResult.error);
    }

    const limit = body.limit ?? LIMITS.entitiesWindowSizeDefault;
    const result = yield* Result.await(
      queryEntities({
        safeDb,
        workspaceId,
        currentUserId: currentUser.id,
        currentOrganizationId: session.activeOrganizationId,
        filters: body.filters ?? [],
        sorts: body.sorts ?? [],
        cursor: cursorResult.value,
        limit: limit + 1,
        fieldMode: body.fieldMode ?? "full",
        fieldIds: body.fieldIds ?? [],
        excludedKinds: body.excludedKinds ?? [],
        extraConditions: [conditionResult.value],
      }),
    );

    const page = createCursorPage({
      rows: result.entities,
      limit,
      cursorForItem: (item) =>
        encodeEntitiesWindowCursor(
          result.cursorValuesByEntityId.get(item.entityId) ??
            panic("Missing cursor values for Kanban group item"),
        ),
    });

    return Result.ok(page);
  },
);

export default readKanbanGroup;
