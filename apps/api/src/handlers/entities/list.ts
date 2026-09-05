import { panic, Result } from "better-result";
import { t } from "elysia";

import { ENTITY_KINDS } from "@stll/api-contract";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tPaginationCursor, tSafeId } from "@/api/lib/custom-schema";
import { queryEntities } from "@/api/lib/entities/query-entities";
import {
  decodeEntitiesWindowCursor,
  ENTITIES_WINDOW_CURSOR_MAX_LENGTH,
  encodeEntitiesWindowCursor,
} from "@/api/lib/entities/window-cursor";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { tViewSortSchema } from "@/api/lib/views-schema";

const readEntitiesBodySchema = t.Object({
  filters: t.Optional(
    t.Array(tConditionNode, { maxItems: LIMITS.viewFiltersCount }),
  ),
  sorts: t.Optional(
    t.Array(tViewSortSchema, { maxItems: LIMITS.viewSortsCount }),
  ),
  cursor: t.Optional(
    tPaginationCursor({ maxChars: ENTITIES_WINDOW_CURSOR_MAX_LENGTH }),
  ),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesPageSizeMax,
      description: "Max entities to return",
    }),
  ),
  fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
  excludedKinds: t.Optional(
    t.Array(t.UnionEnum([...ENTITY_KINDS]), {
      maxItems: ENTITY_KINDS.length,
    }),
  ),
  previewableForAi: t.Optional(t.Boolean()),
});

const config = {
  description:
    "List a matter's documents, folders, and tasks as table rows, using the " +
    "same filters, sorts, and search the matter's views use, with cursor " +
    "pagination. fieldMode and fieldIds choose which column values come " +
    "back, excludedKinds drops kinds you do not want, and previewableForAi " +
    "keeps only documents whose content a model can read. Use " +
    "entities.read-filesystem-tree for the same query shaped as a folder " +
    "tree, and entities.get to read one row in full.",
  permissions: { workspace: ["read"] },
  mcp: { type: "tool", name: "list_documents" },
  access: "read",
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
