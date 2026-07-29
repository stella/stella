import { Result } from "better-result";
import * as v from "valibot";

import { ENTITY_KINDS } from "@/api/db/schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import {
  SAVED_SEARCH_CRITERIA_VERSION,
  SAVED_SEARCH_SORTS,
  type SavedSearchCriteria,
  type SavedSearchTimeFilter,
} from "@/api/lib/saved-searches";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

const SEARCH_TIME_PRESETS = ["day", "week", "month", "year"] as const;

const workspaceIdSchema = v.pipe(v.string(), v.regex(UUID_PATTERN));
const userIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const mimeTypeSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(128),
);
const timestampSchema = v.pipe(v.string(), v.isoTimestamp());

const customTimeFilterSchema = v.strictObject({
  type: v.literal("custom"),
  updatedFrom: v.optional(timestampSchema),
  updatedTo: v.optional(timestampSchema),
});

const savedSearchTimeFilterSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("preset"),
    preset: v.picklist(SEARCH_TIME_PRESETS),
  }),
  customTimeFilterSchema,
]);

const savedSearchCriteriaSchema = v.strictObject({
  version: v.literal(SAVED_SEARCH_CRITERIA_VERSION),
  query: v.pipe(v.string(), v.trim(), v.maxLength(LIMITS.searchQueryMaxLength)),
  workspaceIds: v.pipe(v.array(workspaceIdSchema), v.maxLength(64)),
  types: v.pipe(
    v.array(v.picklist(GLOBAL_SEARCH_RESULT_TYPES)),
    v.maxLength(GLOBAL_SEARCH_RESULT_TYPES.length),
  ),
  kinds: v.pipe(
    v.array(v.picklist(ENTITY_KINDS)),
    v.maxLength(ENTITY_KINDS.length),
  ),
  editedByUserIds: v.pipe(v.array(userIdSchema), v.maxLength(64)),
  mimeTypes: v.pipe(v.array(mimeTypeSchema), v.maxLength(64)),
  time: v.optional(savedSearchTimeFilterSchema),
  sort: v.picklist(SAVED_SEARCH_SORTS),
});

const savedSearchNameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(256),
);

const criteriaError = (message: string) =>
  Result.err(new HandlerError({ status: 422, message }));

const hasSelectiveFilter = (criteria: SavedSearchCriteria): boolean =>
  criteria.types.length > 0 ||
  criteria.kinds.length > 0 ||
  criteria.editedByUserIds.length > 0 ||
  criteria.mimeTypes.length > 0 ||
  criteria.time?.type === "preset" ||
  criteria.time?.updatedFrom !== undefined ||
  criteria.time?.updatedTo !== undefined;

const hasValidCustomTimeRange = (
  time: SavedSearchTimeFilter | undefined,
): boolean =>
  time?.type !== "custom" ||
  time.updatedFrom === undefined ||
  time.updatedTo === undefined ||
  time.updatedFrom <= time.updatedTo;

/**
 * Parses and normalizes persisted criteria for every write path. Workspace-only
 * searches are deliberately rejected: the UI preloads a workspace and such a
 * saved query would otherwise become an accidental unbounded browse request.
 */
export const validateSavedSearchCriteria = (
  value: unknown,
): Result<SavedSearchCriteria, HandlerError<422>> => {
  const parsed = v.safeParse(savedSearchCriteriaSchema, value);
  if (!parsed.success) {
    return criteriaError("Invalid saved search criteria");
  }

  const criteria: SavedSearchCriteria = {
    version: parsed.output.version,
    query: parsed.output.query,
    workspaceIds: parsed.output.workspaceIds.map(brandPersistedWorkspaceId),
    types: [...parsed.output.types],
    kinds: [...parsed.output.kinds],
    editedByUserIds: parsed.output.editedByUserIds.map(brandPersistedUserId),
    mimeTypes: [...parsed.output.mimeTypes],
    time: parsed.output.time,
    sort: parsed.output.sort,
  };

  if (criteria.query.length === 0 && !hasSelectiveFilter(criteria)) {
    return criteriaError(
      "A saved search without text requires a type, kind, editor, MIME type, or date filter",
    );
  }
  if (!hasValidCustomTimeRange(criteria.time)) {
    return criteriaError("The updated date range is invalid");
  }

  return Result.ok(criteria);
};

export const validateSavedSearchName = (
  value: unknown,
): Result<string, HandlerError<422>> => {
  const parsed = v.safeParse(savedSearchNameSchema, value);
  return parsed.success
    ? Result.ok(parsed.output)
    : criteriaError("Invalid saved search name");
};
