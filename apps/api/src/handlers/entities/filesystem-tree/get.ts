import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import { t } from "elysia";

import { entities } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { toSafeId } from "@/api/lib/branded-types";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tPaginationCursor, tSafeId } from "@/api/lib/custom-schema";
import { queryEntities } from "@/api/lib/entities/query-entities";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
  ENTITIES_WINDOW_CURSOR_MAX_LENGTH,
} from "@/api/lib/entities/window-cursor";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { tViewSortSchema } from "@/api/lib/views-schema";

const readFilesystemTreeBodySchema = t.Object({
  cursor: t.Optional(
    tPaginationCursor({ maxChars: ENTITIES_WINDOW_CURSOR_MAX_LENGTH }),
  ),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.entitiesPageSizeMax }),
  ),
  filters: t.Optional(
    t.Array(tConditionNode, { maxItems: LIMITS.viewFiltersCount }),
  ),
  sorts: t.Optional(
    t.Array(tViewSortSchema, { maxItems: LIMITS.viewSortsCount }),
  ),
  search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
  fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
});

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
  body: readFilesystemTreeBodySchema,
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
      const cursorResult = decodeEntitiesWindowCursor(body.cursor);
      if (Result.isError(cursorResult)) {
        return Result.err(cursorResult.error);
      }
      const limit = normalizeTenantPageLimit(
        body.limit ?? LIMITS.entitiesPageSizeDefault,
      );
      const result = yield* Result.await(
        queryEntitiesImpl({
          safeDb,
          scope: { type: "matter", workspaceId },
          currentUserId: currentUser.id,
          currentOrganizationId: session.activeOrganizationId,
          filters: arrayOrEmpty(body.filters),
          sorts: arrayOrEmpty(body.sorts),
          ...(body.search !== undefined && { search: body.search }),
          cursor: cursorResult.value,
          limit: limit + 1,
          fieldMode: body.fieldMode ?? "visible",
          fieldIds: arrayOrEmpty(body.fieldIds),
          excludedKinds: ["task"],
          previewableForAi: false,
        }),
      );

      const page = createCursorPage({
        rows: result.entities,
        limit,
        cursorForItem: (item) =>
          encodeEntitiesWindowCursor(
            result.cursorValuesByEntityId.get(item.entityId) ??
              panic("Missing cursor values for filesystem page item"),
          ),
      });
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
          entityId: toSafeId<"entity">(entityId),
          parentId: parentId === null ? null : toSafeId<"entity">(parentId),
        }));
      return Result.ok({ ...page, ancestorLinks });
    },
  );

const readFilesystemTree = createReadFilesystemTreeHandler();

export default readFilesystemTree;
