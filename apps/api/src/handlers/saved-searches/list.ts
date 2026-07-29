import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import { savedSearches } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedSavedSearchId } from "@/api/lib/safe-id-boundaries";

import { toSavedSearchResponse } from "./response";
import { savedSearchListQuerySchema } from "./schema";

const config = {
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  query: savedSearchListQuerySchema,
} satisfies HandlerConfig;

export const savedSearchCursor = createTimestampIdCursorCodec({
  column: savedSearches.updatedAt,
  brandId: brandPersistedSavedSearchId,
});

const listSavedSearches = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, query }) {
    const limit = query.limit ?? LIMITS.savedSearchesPageSizeDefault;
    const organizationId = session.activeOrganizationId;
    const conditions = [
      eq(savedSearches.organizationId, organizationId),
      eq(savedSearches.userId, user.id),
    ];

    if (query.cursor) {
      const cursor = savedSearchCursor.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = savedSearchCursor.keysetAfter({
        cursor,
        idColumn: savedSearches.id,
        direction: "descending",
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: savedSearches.id,
            organizationId: savedSearches.organizationId,
            userId: savedSearches.userId,
            name: savedSearches.name,
            criteria: savedSearches.criteria,
            createdAt: savedSearches.createdAt,
            updatedAt: savedSearches.updatedAt,
            updatedAtCursor:
              savedSearchCursor.cursorValue.as("updated_at_cursor"),
          })
          .from(savedSearches)
          .where(and(...conditions))
          .orderBy(desc(savedSearches.updatedAt), desc(savedSearches.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        savedSearchCursor.encode(item.updatedAtCursor, item.id),
    });

    return Result.ok({
      ...page,
      items: page.items.map(toSavedSearchResponse),
    });
  },
);

export default listSavedSearches;
