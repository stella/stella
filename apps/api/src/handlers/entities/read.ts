import { panic, Result } from "better-result";
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
import { createCursorPage } from "@/api/lib/pagination";
import {
  tViewFilterConditionSchema,
  tViewSortSchema,
} from "@/api/lib/views-schema";

const readEntitiesBodySchema = t.Object({
  filters: t.Optional(t.Array(tViewFilterConditionSchema)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  page: t.Optional(t.Integer({ minimum: 1 })),
  cursor: t.Optional(t.String()),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  pageSize: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesPageSizeMax,
    }),
  ),
  fieldMode: t.Optional(t.UnionEnum(["full", "visible"])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
  excludedKinds: t.Optional(
    t.Array(t.UnionEnum(["document", "folder", "task", "message", "link"]), {
      maxItems: 5,
    }),
  ),
  previewableForAi: t.Optional(t.Boolean()),
});

const config = {
  permissions: { workspace: ["read"] },
  body: readEntitiesBodySchema,
} satisfies HandlerConfig;

type QueryEntities = typeof queryEntities;

export const createReadEntitiesHandler = (
  queryEntitiesImpl: QueryEntities = queryEntities,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      workspaceId,
      session,
      body,
      user: currentUser,
    }) {
      const page = body.page ?? 1;
      const pageSize = body.pageSize ?? LIMITS.entitiesPageSizeDefault;
      const legacyPageOffset =
        page > 1 && body.cursor === undefined ? (page - 1) * pageSize : 0;

      const cursorResult = decodeEntitiesWindowCursor(body.cursor);
      if (Result.isError(cursorResult)) {
        return Result.err(cursorResult.error);
      }

      const result = yield* Result.await(
        queryEntitiesImpl({
          safeDb,
          workspaceId,
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          filters: body.filters ?? [],
          sorts: body.sorts ?? [],
          ...(body.search !== undefined && { search: body.search }),
          cursor: cursorResult.value,
          offset: legacyPageOffset,
          limit: pageSize + 1,
          fieldMode: body.fieldMode ?? "full",
          fieldIds: body.fieldIds ?? [],
          excludedKinds: body.excludedKinds ?? [],
          previewableForAi: body.previewableForAi ?? false,
          includeTotalCount: true,
        }),
      );

      const cursorPage = createCursorPage({
        rows: result.entities,
        limit: pageSize,
        cursorForItem: (item) =>
          encodeEntitiesWindowCursor(
            result.cursorValuesByEntityId.get(item.entityId) ??
              panic("Missing cursor values for entity page item"),
          ),
      });

      return Result.ok({
        entities: cursorPage.items,
        nextCursor: cursorPage.nextCursor,
        totalCount: result.totalCount ?? 0,
        page,
        pageSize,
      });
    },
  );

const readEntities = createReadEntitiesHandler();

export default readEntities;
