import { Result } from "better-result";
import { sql } from "drizzle-orm";

import { entities } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  queryEntities,
  queryMatterEntityCursorPage,
} from "@/api/lib/entities/query-entities";
import { entityReadPageBodySchema } from "@/api/lib/entities/query-window-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

const config = {
  contract: "patch",
  description:
    "Read a cursor page of a matter's folders and documents, using " +
    "the same filters, sorts, and search as the table listings; tasks are " +
    "excluded. When a filter or search hides intermediate folders, their " +
    "parent links come back separately as ancestorLinks, so a matched row's " +
    "full path can still be resolved without those folders entering the tree " +
    "itself.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "list_documents" },
  access: "read",
  body: entityReadPageBodySchema,
} satisfies WorkspaceHandlerConfig;

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
      const page = yield* Result.await(
        queryMatterEntityCursorPage({
          body,
          workspaceId,
          safeDb,
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          queryEntitiesImpl,
          excludedKinds: ["task"],
          previewableForAi: false,
        }),
      );

      const parentIds = [
        ...new Set(
          page.items.flatMap((item) =>
            item.parentId === null ? [] : [item.parentId],
          ),
        ),
      ];
      if (parentIds.length === 0) {
        return Result.ok({ ...page, ancestorLinks: [] });
      }

      // Traverse only this page's parent chains. A complete matter skeleton
      // makes even a small filtered page scan every unrelated folder.
      const ancestors = yield* Result.await(
        safeDb((tx) =>
          tx.execute<{
            entityId: string;
            parentId: string | null;
            depth: number;
          }>(sql`
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_id, 1 AS depth
            FROM ${entities}
            WHERE workspace_id = ${workspaceId}
              AND id IN (${sql.join(
                parentIds.map((id) => sql`${id}`),
                sql`, `,
              )})
              AND kind = 'folder'
            UNION
            SELECT e.id, e.parent_id, a.depth + 1
            FROM ${entities} e
            INNER JOIN ancestors a ON e.id = a.parent_id
            WHERE e.workspace_id = ${workspaceId}
              AND e.kind = 'folder'
              AND a.depth < ${LIMITS.entityAncestorWalkDepthMax}
          )
          SELECT id AS "entityId", parent_id AS "parentId", max(depth)::integer AS depth
          FROM ancestors GROUP BY id, parent_id
        `),
        ),
      );
      if (
        ancestors.some(
          (ancestor) =>
            ancestor.depth >= LIMITS.entityAncestorWalkDepthMax &&
            ancestor.parentId !== null,
        )
      ) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Folder ancestry exceeds the supported depth",
          }),
        );
      }
      const presentIds = new Set(page.items.map((item) => item.entityId));
      const ancestorLinks = ancestors
        .filter((ancestor) => !presentIds.has(ancestor.entityId))
        .map(({ entityId, parentId }) => ({
          entityId: brandPersistedEntityId(entityId),
          parentId: parentId === null ? null : brandPersistedEntityId(parentId),
        }));
      return Result.ok({ ...page, ancestorLinks });
    },
  );

const readFilesystemTree = createReadFilesystemTreeHandler();

export default readFilesystemTree;
