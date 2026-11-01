import * as v from "valibot";

import { ENTITY_KINDS } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import { resourceIdSchema, userIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

/**
 * The filter fields a search, its facets and a saved search share, so the
 * three request bodies accept exactly the same filters.
 */
export const searchFilterFields = {
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
};
