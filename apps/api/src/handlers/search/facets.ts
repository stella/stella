import * as v from "valibot";

import { apiDateTimeSchema } from "@stll/api-contract/api-date";

import type { ScopedDb } from "@/api/db/safe-db";
import { ENTITY_KINDS } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import {
  hasSearchQueryOrSelectiveFilter,
  resolveSelectedWorkspaceIds,
} from "@/api/handlers/search/search";
import { status } from "@/api/http/status";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema, userIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { searchGlobalFacet } from "@/api/lib/search/index-global";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

const isoDateTime = apiDateTimeSchema;

const FACET_NAMES = ["editor", "workspace", "mimeType"] as const;

const FACET_BUCKET_LIMIT_MAX = 50;
const FACET_BUCKET_LIMIT_DEFAULT = 20;
const FACET_SEARCH_MAX = 256;

export const searchFacetsBodySchema = v.object({
  facet: v.picklist(FACET_NAMES),
  search: v.optional(v.pipe(v.string(), v.maxLength(FACET_SEARCH_MAX)), ""),
  query: v.pipe(v.string(), v.maxLength(LIMITS.searchQueryMaxLength)),
  workspaceIds: v.pipe(v.array(resourceIdSchema("workspace")), v.maxLength(64)),
  types: v.pipe(
    v.array(v.picklist(GLOBAL_SEARCH_RESULT_TYPES)),
    v.maxLength(GLOBAL_SEARCH_RESULT_TYPES.length),
  ),
  kinds: v.optional(
    v.pipe(v.array(entityKindSchema), v.maxLength(ENTITY_KINDS.length)),
  ),
  editedByUserIds: v.pipe(v.array(userIdSchema), v.maxLength(64)),
  mimeTypes: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  updatedFrom: v.optional(isoDateTime),
  updatedTo: v.optional(isoDateTime),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(FACET_BUCKET_LIMIT_MAX),
    ),
    FACET_BUCKET_LIMIT_DEFAULT,
  ),
});

type SearchFacetsBody = v.InferOutput<typeof searchFacetsBodySchema>;

type SearchFacetsHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  body: SearchFacetsBody;
};

export const searchFacetsHandler = async ({
  scopedDb,
  organizationId,
  accessibleWorkspaceIds,
  body,
}: SearchFacetsHandlerProps) => {
  if (!hasSearchQueryOrSelectiveFilter(body)) {
    return status(400, {
      message: "Provide a search query or at least one filter",
    });
  }

  const resolved = await resolveSelectedWorkspaceIds({
    scopedDb,
    organizationId,
    accessibleWorkspaceIds,
    requestedWorkspaceIds: body.workspaceIds,
  });
  if (resolved.kind === "error") {
    return resolved.response;
  }

  const fallbackTypes = arrayOrEmpty(body.kinds);
  const types = body.types.length > 0 ? body.types : fallbackTypes;

  return await searchGlobalFacet(
    {
      facet: body.facet,
      search: body.search,
      query: body.query,
      organizationId,
      accessibleWorkspaceIds,
      selectedWorkspaceIds: resolved.ids,
      types,
      editedByUserIds: body.editedByUserIds,
      mimeTypes: body.mimeTypes,
      updatedFrom: body.updatedFrom,
      updatedTo: body.updatedTo,
      limit: normalizeTenantPageLimit(body.limit ?? FACET_BUCKET_LIMIT_DEFAULT),
    },
    scopedDb,
  );
};
