import { Result } from "better-result";
import { t } from "elysia";

import { queryEntities } from "@/api/handlers/entities/query-entities";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/handlers/entities/window-cursor";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  tViewFilterConditionSchema,
  tViewSortSchema,
} from "@/api/lib/views-schema";

const readEntitiesWindowBodySchema = t.Object({
  filters: t.Optional(t.Array(tViewFilterConditionSchema)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesWindowSizeMax,
    }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
  excludedKinds: t.Optional(
    t.Array(t.UnionEnum(["document", "folder", "task", "message", "link"]), {
      maxItems: 5,
    }),
  ),
  fieldMode: t.Optional(t.UnionEnum(["full", "visible"])),
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

    const offset = cursorResult.value;
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
        offset,
        limit: limit + 1,
        fieldMode: body.fieldMode ?? "full",
        fieldIds: body.fieldIds ?? [],
        excludedKinds: body.excludedKinds ?? [],
        previewableForAi: body.previewableForAi ?? false,
        includeTotalCount: false,
      }),
    );

    const hasMore = result.entities.length > limit;
    const entities = result.entities.slice(0, limit);

    return Result.ok({
      entities,
      limit,
      nextCursor: hasMore ? encodeEntitiesWindowCursor(offset + limit) : null,
    });
  },
);

export default readEntitiesWindow;
