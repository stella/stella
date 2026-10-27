import * as v from "valibot";

import { apiDateTimeSchema } from "@stll/api-contract/api-date";
import { numberFromString } from "@stll/api-contract/http-input";

import { ENTITY_KINDS } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import {
  paginationCursorSchema,
  resourceIdSchema,
  userIdSchema,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  SAVED_SEARCH_CRITERIA_VERSION,
  SAVED_SEARCH_SORTS,
} from "@/api/lib/saved-searches";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

const timestampSchema = apiDateTimeSchema;

const timeFilterSchema = v.union([
  v.strictObject({
    type: v.literal("preset"),
    preset: v.picklist(["day", "week", "month", "year"]),
  }),
  v.strictObject({
    type: v.literal("custom"),
    updatedFrom: v.optional(timestampSchema),
    updatedTo: v.optional(timestampSchema),
  }),
]);

const savedSearchCriteriaBodySchema = v.strictObject({
  version: v.literal(SAVED_SEARCH_CRITERIA_VERSION),
  query: v.pipe(v.string(), v.maxLength(LIMITS.searchQueryMaxLength)),
  workspaceIds: v.pipe(v.array(resourceIdSchema("workspace")), v.maxLength(64)),
  types: v.pipe(
    v.array(v.picklist(GLOBAL_SEARCH_RESULT_TYPES)),
    v.maxLength(GLOBAL_SEARCH_RESULT_TYPES.length),
  ),
  kinds: v.pipe(v.array(entityKindSchema), v.maxLength(ENTITY_KINDS.length)),
  editedByUserIds: v.pipe(v.array(userIdSchema), v.maxLength(64)),
  mimeTypes: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    v.maxLength(64),
  ),
  time: v.optional(timeFilterSchema),
  sort: v.picklist(SAVED_SEARCH_SORTS),
});

export const savedSearchParamsSchema = v.object({
  savedSearchId: resourceIdSchema("savedSearch"),
});

export const savedSearchListQuerySchema = v.object({
  cursor: v.optional(paginationCursorSchema()),
  limit: v.optional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.savedSearchesPageSizeMax),
      ),
    ),
  ),
});

export const createSavedSearchBodySchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  criteria: savedSearchCriteriaBodySchema,
});

export const updateSavedSearchBodySchema = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  criteria: v.optional(savedSearchCriteriaBodySchema),
});
