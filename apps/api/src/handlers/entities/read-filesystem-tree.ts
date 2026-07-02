import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { entities } from "@/api/db/schema";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import { collectMissingAncestorIds } from "@/api/handlers/entities/read-filesystem-tree.logic";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
  mcp: { type: "pending" },
  body: readFilesystemTreeBodySchema,
} satisfies HandlerConfig;

type QueryEntities = typeof queryEntities;

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
        return Result.ok({ entities: result.entities, ancestorLinks: [] });
      }

      const folderSkeleton = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ entityId: entities.id, parentId: entities.parentId })
            .from(entities)
            .where(
              and(
                eq(entities.workspaceId, workspaceId),
                eq(entities.kind, "folder"),
              ),
            ),
        ),
      );
      const parentById = new Map(
        folderSkeleton.map((folder) => [folder.entityId, folder.parentId]),
      );
      const missingIds = new Set(
        collectMissingAncestorIds(result.entities, parentById),
      );

      // Just the parent links of the folders the filter/search hid, so the
      // client can resolve a matched row's full ancestor chain (for
      // cross-matter copy/move dedup) without these folders ever entering the
      // rendered or selectable tree.
      const ancestorLinks = folderSkeleton.filter((folder) =>
        missingIds.has(folder.entityId),
      );

      return Result.ok({ entities: result.entities, ancestorLinks });
    },
  );

const readFilesystemTree = createReadFilesystemTreeHandler();

export default readFilesystemTree;
