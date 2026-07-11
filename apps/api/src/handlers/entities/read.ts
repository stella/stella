import { panic, Result } from "better-result";
import { t } from "elysia";

import { queryEntities } from "@/api/handlers/entities/query-entities";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/handlers/entities/window-cursor";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { tViewSortSchema } from "@/api/lib/views-schema";

const readEntitiesBodySchema = t.Object({
  filters: t.Optional(t.Array(tConditionNode)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  cursor: t.Optional(t.String()),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesPageSizeMax,
    }),
  ),
  fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")])),
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
  mcp: { type: "tool", name: "list_documents" },
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
      const cursorResult = decodeEntitiesWindowCursor(body.cursor);
      if (Result.isError(cursorResult)) {
        return Result.err(cursorResult.error);
      }

      const limit = body.limit ?? LIMITS.entitiesPageSizeDefault;
      const result = yield* Result.await(
        queryEntitiesImpl({
          safeDb,
          workspaceId,
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          filters: arrayOrEmpty(body.filters),
          sorts: arrayOrEmpty(body.sorts),
          ...(body.search !== undefined && { search: body.search }),
          cursor: cursorResult.value,
          limit: limit + 1,
          fieldMode: body.fieldMode ?? "full",
          fieldIds: arrayOrEmpty(body.fieldIds),
          excludedKinds: arrayOrEmpty(body.excludedKinds),
          previewableForAi: body.previewableForAi ?? false,
        }),
      );

      return Result.ok(
        createCursorPage({
          rows: result.entities,
          limit,
          cursorForItem: (item) =>
            encodeEntitiesWindowCursor(
              result.cursorValuesByEntityId.get(item.entityId) ??
                panic("Missing cursor values for entity page item"),
            ),
        }),
      );
    },
  );

const readEntities = createReadEntitiesHandler();

export default readEntities;
