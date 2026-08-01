import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { ENTITY_KINDS } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { searchGlobal } from "@/api/lib/search/index-global";
import { parseGlobalSearchCursor } from "@/api/lib/search/pagination";
import { getSearchPreviewLocatorCandidates } from "@/api/lib/search/query";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

const isoDateTime = t.String({ format: "date-time" });

export const searchBodySchema = t.Object({
  query: t.String({
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  workspaceIds: t.Array(tSafeId("workspace"), { maxItems: 64 }),
  types: t.Array(t.UnionEnum(GLOBAL_SEARCH_RESULT_TYPES), {
    maxItems: GLOBAL_SEARCH_RESULT_TYPES.length,
  }),
  kinds: t.Array(entityKindSchema, { maxItems: ENTITY_KINDS.length }),
  editedByUserIds: t.Array(tUserId, { maxItems: 64 }),
  mimeTypes: t.Array(t.String({ minLength: 1, maxLength: 128 })),
  updatedFrom: t.Optional(isoDateTime),
  updatedTo: t.Optional(isoDateTime),
  cursor: t.Optional(t.String()),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.searchPageSizeMax,
      default: LIMITS.searchPageSizeDefault,
    }),
  ),
});

type SearchBodySchema = Static<typeof searchBodySchema>;

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

  const result = await search({
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
    limit: body.limit ?? LIMITS.searchPageSizeDefault,
  });

  return {
    ...result,
    previewLocatorCandidates: getSearchPreviewLocatorCandidates(body.query),
  };
};
