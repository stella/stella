import { t } from "elysia";

import { ENTITY_KINDS } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import { tPaginationCursor, tSafeId, tUserId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  SAVED_SEARCH_CRITERIA_VERSION,
  SAVED_SEARCH_SORTS,
} from "@/api/lib/saved-searches";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

const timestampSchema = t.String({ format: "date-time" });

const timeFilterSchema = t.Union([
  t.Object(
    {
      type: t.Literal("preset"),
      preset: t.UnionEnum(["day", "week", "month", "year"]),
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      type: t.Literal("custom"),
      updatedFrom: t.Optional(timestampSchema),
      updatedTo: t.Optional(timestampSchema),
    },
    { additionalProperties: false },
  ),
]);

export const savedSearchCriteriaBodySchema = t.Object(
  {
    version: t.Literal(SAVED_SEARCH_CRITERIA_VERSION),
    query: t.String({ maxLength: LIMITS.searchQueryMaxLength }),
    workspaceIds: t.Array(tSafeId("workspace"), { maxItems: 64 }),
    types: t.Array(t.UnionEnum(GLOBAL_SEARCH_RESULT_TYPES), {
      maxItems: GLOBAL_SEARCH_RESULT_TYPES.length,
    }),
    kinds: t.Array(entityKindSchema, { maxItems: ENTITY_KINDS.length }),
    editedByUserIds: t.Array(tUserId, { maxItems: 64 }),
    mimeTypes: t.Array(t.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 64,
    }),
    time: t.Optional(timeFilterSchema),
    sort: t.UnionEnum(SAVED_SEARCH_SORTS),
  },
  { additionalProperties: false },
);

export const savedSearchParamsSchema = t.Object({
  savedSearchId: tSafeId("savedSearch"),
});

export const savedSearchListQuerySchema = t.Object({
  cursor: t.Optional(tPaginationCursor()),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.savedSearchesPageSizeMax }),
  ),
});

export const createSavedSearchBodySchema = t.Object(
  {
    name: t.String({ minLength: 1, maxLength: 256 }),
    criteria: savedSearchCriteriaBodySchema,
  },
  { additionalProperties: false },
);

export const updateSavedSearchBodySchema = t.Object(
  {
    name: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
    criteria: t.Optional(savedSearchCriteriaBodySchema),
  },
  { additionalProperties: false },
);
