import { Result } from "better-result";
import { and, asc, eq, gt } from "drizzle-orm";
import { t } from "elysia";

import { legalListItemSources } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { projectListSourceVerification } from "@/api/lib/lists/detail-projection";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedLegalListItemSourceId } from "@/api/lib/safe-id-boundaries";

const paramsSchema = workspaceParams({
  listId: tSafeId("legalList"),
  itemEntityId: tSafeId("entity"),
});
const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.legalListSourcesPageSizeMax }),
  ),
  cursor: t.Optional(tPaginationCursor()),
});
const config = {
  description:
    "List the sources attached to one list item with cursor pagination, each " +
    "with the document version it points at, its locator, its quote, and its " +
    "verificationDetailsStatus: visible or feature_unavailable. Visible " +
    "verification includes status, reviewer and time; unavailable fields are null.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: paramsSchema,
  query: querySchema,
} satisfies WorkspaceHandlerConfig;

const readItemSources = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params,
    query,
    session,
    user,
    featureAccessSnapshot,
  }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.legalListSourcesPageSizeDefault,
    );
    const cursorParts = query.cursor
      ? decodePaginationCursor(query.cursor)
      : null;
    const rawCursor = cursorParts?.at(0);
    if (query.cursor && !isUuidPaginationCursorPart(rawCursor)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursor = isUuidPaginationCursorPart(rawCursor)
      ? brandPersistedLegalListItemSourceId(rawCursor)
      : null;
    const conditions = [
      eq(legalListItemSources.workspaceId, workspaceId),
      eq(legalListItemSources.listId, params.listId),
      eq(legalListItemSources.itemEntityId, params.itemEntityId),
    ];
    if (cursor !== null) {
      conditions.push(gt(legalListItemSources.id, cursor));
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const item = await tx.query.legalListItems.findFirst({
          where: {
            entityId: { eq: params.itemEntityId },
            listId: { eq: params.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { entityId: true },
        });
        if (!item) {
          return null;
        }
        return await tx
          .select({
            id: legalListItemSources.id,
            sourceEntityId: legalListItemSources.sourceEntityId,
            sourceEntityVersionId: legalListItemSources.sourceEntityVersionId,
            locator: legalListItemSources.locator,
            quote: legalListItemSources.quote,
            verificationStatus: legalListItemSources.verificationStatus,
            verifiedBy: legalListItemSources.verifiedBy,
            verifiedAt: legalListItemSources.verifiedAt,
            createdAt: legalListItemSources.createdAt,
          })
          .from(legalListItemSources)
          .where(and(...conditions))
          .orderBy(asc(legalListItemSources.id))
          .limit(limit + 1);
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "List item not found" }),
      );
    }
    return Result.ok(
      createCursorPage({
        rows: result.map((source) =>
          projectListSourceVerification(source, {
            featureAccessSnapshot,
            principal: {
              organizationId: session.activeOrganizationId,
              userId: user.id,
            },
          }),
        ),
        limit,
        cursorForItem: (item) => encodePaginationCursor([item.id]),
      }),
    );
  },
);

export default readItemSources;
