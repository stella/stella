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

const readEntitiesWindowBodySchema = t.Object({
  filters: t.Optional(
    t.Array(tConditionNode, { maxItems: LIMITS.viewFiltersCount }),
  ),
  sorts: t.Optional(
    t.Array(tViewSortSchema, { maxItems: LIMITS.viewSortsCount }),
  ),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesWindowSizeMax,
    }),
  ),
  cursor: t.Optional(
    tPaginationCursor({ maxChars: ENTITIES_WINDOW_CURSOR_MAX_LENGTH }),
  ),
  excludedKinds: t.Optional(
    t.Array(t.UnionEnum([...ENTITY_KINDS]), {
      maxItems: ENTITY_KINDS.length,
    }),
  ),
  fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
  previewableForAi: t.Optional(t.Boolean()),
  // Off by default; the kanban assignee sub-group is the one caller that
  // needs each task's assignees, so it is the one caller that sets this.
  includeAssignees: t.Optional(t.Boolean()),
});

const config = {
  description:
    "Read a window of a matter's documents, folders, and tasks with the same " +
    "filters, sorts, search, and field selection as entities.list, but with " +
    "the page bounds the virtualized table scrolls by (200 rows by default). " +
    "Prefer entities.list unless you are filling a table viewport.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "read_content_across_matters" },
  access: "read",
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
        filters: arrayOrEmpty(body.filters),
        sorts: arrayOrEmpty(body.sorts),
        ...(body.search !== undefined && { search: body.search }),
        cursor: cursorResult.value,
        limit: limit + 1,
        fieldMode: body.fieldMode ?? "full",
        fieldIds: arrayOrEmpty(body.fieldIds),
        excludedKinds: arrayOrEmpty(body.excludedKinds),
        previewableForAi: body.previewableForAi ?? false,
        includeAssignees: body.includeAssignees ?? false,
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
