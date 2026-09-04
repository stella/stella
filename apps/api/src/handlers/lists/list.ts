import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { LEGAL_LIST_STATUSES, legalLists } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedLegalListId } from "@/api/lib/safe-id-boundaries";
import { includes } from "@/api/lib/type-guards";

const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.legalListsPageSizeMax }),
  ),
  cursor: t.Optional(tPaginationCursor()),
  status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

const config = {
  description:
    "List a matter's lists, newest first, with cursor pagination, filtered " +
    "by status (active by default, archived on request). Each entry carries " +
    "the name, description, status, and timestamps.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "workspace_schema" },
  query: querySchema,
} satisfies HandlerConfig;

const listCursorCodec = createTimestampIdCursorCodec({
  column: legalLists.createdAt,
  brandId: brandPersistedLegalListId,
});

const readLists = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? LIMITS.legalListsPageSizeDefault;
    const status = query.status ?? "active";
    if (!includes(LEGAL_LIST_STATUSES, status)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid List status" }),
      );
    }

    const conditions = [
      eq(legalLists.workspaceId, workspaceId),
      eq(legalLists.status, status),
    ];

    if (query.cursor) {
      const cursor = listCursorCodec.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = listCursorCodec.keysetAfter({
        cursor,
        direction: "descending",
        idColumn: legalLists.id,
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: legalLists.id,
            name: legalLists.name,
            description: legalLists.description,
            status: legalLists.status,
            createdAt: legalLists.createdAt,
            updatedAt: legalLists.updatedAt,
            createdAtCursor:
              listCursorCodec.cursorValue.as("created_at_cursor"),
          })
          .from(legalLists)
          .where(and(...conditions))
          .orderBy(desc(legalLists.createdAt), desc(legalLists.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        listCursorCodec.encode(item.createdAtCursor, item.id),
    });

    return Result.ok({
      ...page,
      items: page.items.map(({ createdAtCursor: _, ...item }) => item),
    });
  },
);

export default readLists;
