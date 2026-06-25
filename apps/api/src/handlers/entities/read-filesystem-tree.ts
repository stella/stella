import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { tViewSortSchema } from "@/api/lib/views-schema";

const readFilesystemTreeBodySchema = t.Object({
  filters: t.Optional(t.Array(tConditionNode)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
});

const config = {
  permissions: { workspace: ["read"] },
  body: readFilesystemTreeBodySchema,
} satisfies HandlerConfig;

type QueryEntities = typeof queryEntities;

type FilesystemEntity = { entityId: string; parentId: string | null };

// Walk up the workspace folder skeleton to collect every ancestor folder of the
// matched rows that the filter/search itself did not return. Without these the
// filtered tree orphans deep descendants and the client cannot resolve their
// ancestor chain (e.g. for cross-matter copy dedup) across the hidden folders.
export const collectMissingAncestorIds = (
  matched: readonly FilesystemEntity[],
  parentById: ReadonlyMap<string, string | null>,
): SafeId<"entity">[] => {
  const presentIds = new Set(matched.map((entity) => entity.entityId));
  const missingIds = new Set<string>();

  for (const entity of matched) {
    const visited = new Set<string>([entity.entityId]);
    let parentId = entity.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (!presentIds.has(parentId)) {
        missingIds.add(parentId);
      }
      parentId = parentById.get(parentId) ?? null;
    }
  }

  // SAFETY: every collected id is a `parentId` from the entities table (the
  // folder skeleton or a matched row), so it is a valid entity id.
  return [...missingIds] as SafeId<"entity">[];
};

const fetchFolderSkeleton = (
  safeDb: SafeDb,
  workspaceId: SafeId<"workspace">,
) =>
  safeDb((tx) =>
    tx
      .select({ entityId: entities.id, parentId: entities.parentId })
      .from(entities)
      .where(
        and(eq(entities.workspaceId, workspaceId), eq(entities.kind, "folder")),
      ),
  );

export const createReadFilesystemTreeHandler = (
  queryEntitiesImpl: QueryEntities = queryEntities,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      workspaceId,
      session,
      body,
      user: currentUser,
    }) {
      const result = yield* Result.await(
        queryEntitiesImpl({
          safeDb,
          workspaceId,
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          filters: body.filters ?? [],
          sorts: body.sorts ?? [],
          ...(body.search !== undefined && { search: body.search }),
          limit: LIMITS.entitiesCount,
          fieldMode: body.fieldMode ?? "full",
          fieldIds: body.fieldIds ?? [],
          excludedKinds: ["task"],
          previewableForAi: false,
          includeTotalCount: false,
        }),
      );

      const isFiltered =
        (body.filters?.length ?? 0) > 0 ||
        (body.search?.trim().length ?? 0) > 0;

      // An unfiltered query already returns the whole subtree, so ancestor
      // backfill only matters when a filter or search can hide intermediates.
      if (!isFiltered || result.entities.length === 0) {
        return Result.ok({ entities: result.entities });
      }

      const folderSkeleton = yield* Result.await(
        fetchFolderSkeleton(safeDb, workspaceId),
      );
      const parentById = new Map(
        folderSkeleton.map((folder) => [folder.entityId, folder.parentId]),
      );
      const missingAncestorIds = collectMissingAncestorIds(
        result.entities,
        parentById,
      );

      if (missingAncestorIds.length === 0) {
        return Result.ok({ entities: result.entities });
      }

      const ancestors = yield* Result.await(
        queryEntitiesImpl({
          safeDb,
          workspaceId,
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          filters: [],
          sorts: [],
          limit: LIMITS.entitiesCount,
          fieldMode: body.fieldMode ?? "full",
          fieldIds: body.fieldIds ?? [],
          excludedKinds: ["task"],
          previewableForAi: false,
          extraConditions: [inArray(entities.id, missingAncestorIds)],
          includeTotalCount: false,
        }),
      );

      return Result.ok({
        entities: [...result.entities, ...ancestors.entities],
      });
    },
  );

const readFilesystemTree = createReadFilesystemTreeHandler();

export default readFilesystemTree;
