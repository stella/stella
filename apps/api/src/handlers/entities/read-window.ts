import { panic, Result } from "better-result";
import { t } from "elysia";

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

const readEntitiesWindowBodySchema = t.Object({
  filters: t.Optional(t.Array(tConditionNode)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesWindowSizeMax,
    }),
  ),
  cursor: t.Optional(t.String()),
  excludedKinds: t.Optional(
    t.Array(t.UnionEnum(["document", "folder", "task", "message", "link"]), {
      maxItems: 5,
    }),
  ),
  fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
  previewableForAi: t.Optional(t.Boolean()),
});

const config = {
  permissions: { workspace: ["read"] },
  body: readEntitiesWindowBodySchema,
} satisfies HandlerConfig;

const readEntitiesWindow = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, body, user: currentUser }) {
    const cursorResult = decodeEntitiesWindowCursor(body.cursor);
    if (Result.isError(cursorResult)) {
      return Result.err(cursorResult.error);
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
        ...(body.search !== undefined && { search: body.search }),
        cursor: cursorResult.value,
        limit: limit + 1,
        fieldMode: body.fieldMode ?? "full",
        fieldIds: body.fieldIds ?? [],
        excludedKinds: body.excludedKinds ?? [],
        previewableForAi: body.previewableForAi ?? false,
        includeTotalCount: false,
      }),
    );

    return Result.ok(
      createCursorPage({
        rows: result.entities,
        limit,
        cursorForItem: (item) =>
          encodeEntitiesWindowCursor(
            result.cursorValuesByEntityId.get(item.entityId) ??
              panic("Missing cursor values for entity window item"),
          ),
      }),
    );
  },
);

export default readEntitiesWindow;
