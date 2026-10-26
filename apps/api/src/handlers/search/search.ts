import * as v from "valibot";

import { isEntityKind } from "@stll/api-contract";
import { apiDateTimeSchema } from "@stll/api-contract/api-date";

import type { ScopedDb } from "@/api/db/safe-db";
import { ENTITY_KINDS } from "@/api/db/schema";
import type { DocumentProcessingStatus } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import { status } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import {
  paginationCursorSchema,
  resourceIdSchema,
  userIdSchema,
} from "@/api/lib/custom-schema";
import { getCurrentVersionProcessingStatuses } from "@/api/lib/entities/document-processing-status";
import { LIMITS } from "@/api/lib/limits";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { searchGlobal } from "@/api/lib/search/index-global";
import { parseGlobalSearchCursor } from "@/api/lib/search/pagination";
import { getSearchPreviewLocatorCandidates } from "@/api/lib/search/query";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";
import type {
  EntityGlobalSearchHit,
  GlobalSearchHit,
} from "@/api/lib/search/types";

const isoDateTime = apiDateTimeSchema;

export const searchBodySchema = v.object({
  query: v.pipe(v.string(), v.maxLength(LIMITS.searchQueryMaxLength)),
  workspaceIds: v.pipe(v.array(resourceIdSchema("workspace")), v.maxLength(64)),
  types: v.pipe(
    v.array(v.picklist(GLOBAL_SEARCH_RESULT_TYPES)),
    v.maxLength(GLOBAL_SEARCH_RESULT_TYPES.length),
  ),
  kinds: v.pipe(v.array(entityKindSchema), v.maxLength(ENTITY_KINDS.length)),
  editedByUserIds: v.pipe(v.array(userIdSchema), v.maxLength(64)),
  mimeTypes: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  updatedFrom: v.optional(isoDateTime),
  updatedTo: v.optional(isoDateTime),
  cursor: v.optional(paginationCursorSchema()),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.searchPageSizeMax),
    ),
    LIMITS.searchPageSizeDefault,
  ),
});

type SearchBodySchema = v.InferOutput<typeof searchBodySchema>;

const isEntitySearchHit = (
  hit: GlobalSearchHit,
): hit is EntityGlobalSearchHit => isEntityKind(hit.type);

type SearchFilterInput = {
  query: string;
  types: readonly unknown[];
  kinds?: readonly unknown[] | undefined;
  editedByUserIds: readonly unknown[];
  mimeTypes: readonly unknown[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
};

/**
 * A caller's workspace allowlist is an authorization boundary, not a search
 * filter. An explicit workspace selection alone would still list an entire
 * matter, so an empty text query needs a selective non-workspace filter.
 */
export const hasSearchQueryOrSelectiveFilter = ({
  query,
  types,
  kinds,
  editedByUserIds,
  mimeTypes,
  updatedFrom,
  updatedTo,
}: SearchFilterInput): boolean =>
  query.trim().length > 0 ||
  types.length > 0 ||
  (kinds?.length ?? 0) > 0 ||
  editedByUserIds.length > 0 ||
  mimeTypes.length > 0 ||
  updatedFrom !== undefined ||
  updatedTo !== undefined;

type WorkspaceNotFoundError = ReturnType<
  typeof status<400, { message: "Workspace not found in organization" }>
>;

type ResolvedWorkspaceIds =
  | { kind: "ok"; ids: SafeId<"workspace">[] }
  | { kind: "error"; response: WorkspaceNotFoundError };

export const resolveSelectedWorkspaceIds = async ({
  scopedDb,
  organizationId,
  accessibleWorkspaceIds,
  requestedWorkspaceIds,
}: {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
  requestedWorkspaceIds: readonly SafeId<"workspace">[] | undefined;
}): Promise<ResolvedWorkspaceIds> => {
  if (!requestedWorkspaceIds || requestedWorkspaceIds.length === 0) {
    return { kind: "ok", ids: [] };
  }

  // Dedupe so a client passing `[ws_1, ws_1]` doesn't fail validation
  // against `findMany`, which only ever returns one row per id.
  const requestedSet = new Set(requestedWorkspaceIds);
  const accessSet = new Set(accessibleWorkspaceIds);
  const accessible = [...requestedSet].filter((id) => accessSet.has(id));
  if (accessible.length !== requestedSet.size) {
    return {
      kind: "error",
      response: status(400, { message: "Workspace not found in organization" }),
    };
  }

  const found = await scopedDb((tx) =>
    tx.query.workspaces.findMany({
      where: {
        id: { in: accessible },
        organizationId: { eq: organizationId },
        status: { ne: "deleting" },
      },
      columns: { id: true },
      limit: accessible.length,
    }),
  );
  if (found.length !== accessible.length) {
    return {
      kind: "error",
      response: status(400, { message: "Workspace not found in organization" }),
    };
  }

  return { kind: "ok", ids: found.map(({ id }) => id) };
};

type SearchHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  body: SearchBodySchema;
  search?: typeof searchGlobal;
};

export const searchHandler = async ({
  scopedDb,
  organizationId,
  userId,
  accessibleWorkspaceIds,
  body,
  search = searchGlobal,
}: SearchHandlerProps) => {
  if (!hasSearchQueryOrSelectiveFilter(body)) {
    return status(400, {
      message: "Provide a search query or at least one filter",
    });
  }

  if (parseGlobalSearchCursor(body.cursor).type === "invalid") {
    return status(400, { message: "Invalid cursor" });
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

  const types = body.types.length > 0 ? body.types : body.kinds;

  const result = await search(
    {
      query: body.query,
      organizationId,
      userId,
      accessibleWorkspaceIds,
      selectedWorkspaceIds: resolved.ids,
      types,
      editedByUserIds: body.editedByUserIds,
      mimeTypes: body.mimeTypes,
      updatedFrom: body.updatedFrom,
      updatedTo: body.updatedTo,
      cursor: body.cursor,
      limit: normalizeTenantPageLimit(body.limit),
    },
    { scopedDb },
  );

  const entityHits = result.hits.filter(isEntitySearchHit);
  const processingStatuses =
    entityHits.length === 0
      ? new Map<string, DocumentProcessingStatus>()
      : await scopedDb(
          async (tx) =>
            await getCurrentVersionProcessingStatuses(
              tx,
              entityHits.map((hit) => hit.resource.id),
            ),
        );

  const hits: GlobalSearchHit[] = result.hits.map((hit) =>
    isEntitySearchHit(hit)
      ? {
          ...hit,
          processingStatus: processingStatuses.get(hit.resource.id) ?? null,
        }
      : hit,
  );

  return {
    ...result,
    hits,
    previewLocatorCandidates: getSearchPreviewLocatorCandidates(body.query),
  };
};
