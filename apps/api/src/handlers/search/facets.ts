import { t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { ENTITY_KINDS } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import { resolveSelectedWorkspaceIds } from "@/api/handlers/search/search";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { searchGlobalFacet } from "@/api/lib/search/index-global";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

const isoDateTime = t.String({ format: "date-time" });

const FACET_NAMES = ["editor", "workspace", "mimeType"] as const;

const FACET_BUCKET_LIMIT_MAX = 50;
const FACET_BUCKET_LIMIT_DEFAULT = 20;
const FACET_SEARCH_MAX = 256;

export const searchFacetsBodySchema = t.Object({
  facet: t.UnionEnum(FACET_NAMES),
  search: t.String({ maxLength: FACET_SEARCH_MAX, default: "" }),
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  workspaceIds: t.Array(tSafeId("workspace"), { maxItems: 64 }),
  types: t.Array(t.UnionEnum(GLOBAL_SEARCH_RESULT_TYPES), {
    maxItems: GLOBAL_SEARCH_RESULT_TYPES.length,
  }),
  kinds: t.Optional(
    t.Array(entityKindSchema, { maxItems: ENTITY_KINDS.length }),
  ),
  editedByUserIds: t.Array(tUserId, { maxItems: 64 }),
  mimeTypes: t.Array(t.String({ minLength: 1, maxLength: 128 })),
  updatedFrom: t.Optional(isoDateTime),
  updatedTo: t.Optional(isoDateTime),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: FACET_BUCKET_LIMIT_MAX,
      default: FACET_BUCKET_LIMIT_DEFAULT,
    }),
  ),
});

type SearchFacetsBody = Static<typeof searchFacetsBodySchema>;

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
  const resolved = await resolveSelectedWorkspaceIds({
    scopedDb,
    organizationId,
    accessibleWorkspaceIds,
    requestedWorkspaceIds: body.workspaceIds,
  });
  if (resolved.kind === "error") {
    return resolved.response;
  }

  const types = body.types.length > 0 ? body.types : (body.kinds ?? []);

  return await searchGlobalFacet({
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
    limit: body.limit ?? FACET_BUCKET_LIMIT_DEFAULT,
  });
};
