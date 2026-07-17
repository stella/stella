import { Result } from "better-result";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { t } from "elysia";

import { LEGAL_LIST_STATUSES, legalLists } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import type { ParsedPgTimestampCursor } from "@/api/lib/db-pagination";
import {
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedLegalListId } from "@/api/lib/safe-id-boundaries";
import { includes } from "@/api/lib/type-guards";

const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.legalListsPageSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
  status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  query: querySchema,
} satisfies HandlerConfig;

type ListCursor = {
  createdAt: ParsedPgTimestampCursor;
  id: SafeId<"legalList">;
};

const decodeCursor = (value: string): ListCursor | null => {
  const parts = decodePaginationCursor(value);
  const createdAt = parsePgTimestampCursorValue(parts?.at(0));
  const id = parts?.at(1);
  if (!createdAt || !isUuidPaginationCursorPart(id)) {
    return null;
  }
  return { createdAt, id: brandPersistedLegalListId(id) };
};

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
      const cursor = decodeCursor(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = or(
        lt(legalLists.createdAt, pgTimestampCursorBoundary(cursor.createdAt)),
        and(
          eq(legalLists.createdAt, pgTimestampCursorBoundary(cursor.createdAt)),
          lt(legalLists.id, cursor.id),
        ),
      );
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
            createdAtCursor: pgTimestampCursorValue(legalLists.createdAt).as(
              "created_at_cursor",
            ),
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
        encodePaginationCursor([item.createdAtCursor, item.id]),
    });

    return Result.ok({
      ...page,
      items: page.items.map(({ createdAtCursor: _, ...item }) => item),
    });
  },
);

export default readLists;
