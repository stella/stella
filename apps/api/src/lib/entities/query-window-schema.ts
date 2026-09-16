import { t } from "elysia";

import { ENTITY_KINDS } from "@stll/api-contract";

import { tConditionNode } from "@/api/lib/conditions/contract";
import { tPaginationCursor, tSafeId } from "@/api/lib/custom-schema";
import { tFind } from "@/api/lib/entities/find-schema";
import { ENTITIES_WINDOW_CURSOR_MAX_LENGTH } from "@/api/lib/entities/window-cursor";
import { LIMITS } from "@/api/lib/limits";
import { tViewSortSchema } from "@/api/lib/views-schema";

export const entityQueryWindowBodySchema = t.Object({
  filters: t.Optional(
    t.Array(tConditionNode, { maxItems: LIMITS.viewFiltersCount }),
  ),
  sorts: t.Optional(
    t.Array(tViewSortSchema, { maxItems: LIMITS.viewSortsCount }),
  ),
  search: t.Optional(
    t.String({
      maxLength: LIMITS.searchQueryMaxLength,
      description:
        "Rank rows by relevance against the asynchronous document-title " +
        "index, and sort by that relevance. For a literal substring filter " +
        "over the rendered rows, use `find`.",
    }),
  ),
  find: t.Optional(tFind),
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
  // Opt in when a view renders or groups by task assignees.
  includeAssignees: t.Optional(t.Boolean()),
});
