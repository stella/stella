import * as v from "valibot";

import { apiDateTimeSchema } from "@stll/api-contract/api-date";
import { numberFromString } from "@stll/api-contract/http-input";

import {
  paginationCursorSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  SAVED_SEARCH_CRITERIA_VERSION,
  SAVED_SEARCH_SORTS,
} from "@/api/lib/saved-searches";
import { searchFilterFields } from "@/api/lib/search/filter-schema";

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
  ...searchFilterFields,
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
