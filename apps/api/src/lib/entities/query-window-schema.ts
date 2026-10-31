import * as v from "valibot";

import { ENTITY_KINDS } from "@stll/api-contract";

import { tConditionNode } from "@/api/lib/conditions/contract";
import {
  paginationCursorSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { tFind } from "@/api/lib/entities/find-schema";
import { ENTITIES_WINDOW_CURSOR_MAX_LENGTH } from "@/api/lib/entities/window-cursor";
import { LIMITS } from "@/api/lib/limits";
import { tViewSortSchema } from "@/api/lib/views-schema";

export const entityQueryWindowBodySchema = v.object({
  filters: v.optional(
    v.pipe(v.array(tConditionNode), v.maxLength(LIMITS.viewFiltersCount)),
  ),
  sorts: v.optional(
    v.pipe(v.array(tViewSortSchema), v.maxLength(LIMITS.viewSortsCount)),
  ),
  search: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(LIMITS.searchQueryMaxLength),
      v.description(
        "Rank rows by relevance against the asynchronous document-title " +
          "index, and sort by that relevance. For a literal substring filter " +
          "over the rendered rows, use `find`.",
      ),
    ),
  ),
  find: v.optional(tFind),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.entitiesWindowSizeMax),
    ),
  ),
  cursor: v.optional(
    paginationCursorSchema({ maxChars: ENTITIES_WINDOW_CURSOR_MAX_LENGTH }),
  ),
  excludedKinds: v.optional(
    v.pipe(
      v.array(v.picklist([...ENTITY_KINDS])),
      v.maxLength(ENTITY_KINDS.length),
    ),
  ),
  fieldMode: v.optional(v.picklist(["full", "visible"])),
  fieldIds: v.optional(
    v.pipe(
      v.array(resourceIdSchema("property")),
      v.maxLength(LIMITS.propertiesCount),
    ),
  ),
  previewableForAi: v.optional(v.boolean()),
  includeAssignees: v.optional(v.boolean()),
});

export const entityReadPageBodySchema = v.object({
  ...v.pick(entityQueryWindowBodySchema, [
    "filters",
    "sorts",
    "cursor",
    "fieldMode",
    "fieldIds",
  ]).entries,
  search: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(LIMITS.searchQueryMaxLength),
      v.description(
        "Rank rows by relevance against the asynchronous document-title index.",
      ),
    ),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.entitiesPageSizeMax),
    ),
  ),
});
