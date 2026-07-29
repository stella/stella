import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { shareItems, shareRecipients, shareSpaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationLimit } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedShareSpaceId } from "@/api/lib/safe-id-boundaries";

const config = {
  permissions: { shareSpace: ["read"] },
  mcp: { type: "capability", reason: "external_sharing" },
  access: "read",
  query: t.Object({
    limit: t.Optional(tPaginationLimit(LIMITS.shareSpacesPageSizeMax)),
    cursor: t.Optional(t.String({ maxLength: 512 })),
  }),
} satisfies HandlerConfig;

const shareSpaceCursor = createTimestampIdCursorCodec({
  column: shareSpaces.createdAt,
  brandId: brandPersistedShareSpaceId,
});

const listShareSpaces = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, query }) {
    const limit = query.limit ?? LIMITS.shareSpacesPageSizeDefault;
    const conditions = [eq(shareSpaces.workspaceId, workspaceId)];
    if (query.cursor) {
      const cursor = shareSpaceCursor.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const after = shareSpaceCursor.keysetAfter({
        cursor,
        idColumn: shareSpaces.id,
        direction: "descending",
      });
      if (after) {
        conditions.push(after);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: shareSpaces.id,
            name: shareSpaces.name,
            status: shareSpaces.status,
            downloadPolicy: shareSpaces.downloadPolicy,
            expiresAt: shareSpaces.expiresAt,
            revokedAt: shareSpaces.revokedAt,
            createdAt: shareSpaces.createdAt,
            createdAtCursor:
              shareSpaceCursor.cursorValue.as("created_at_cursor"),
            recipientCount: sql<number>`(
              SELECT count(*)::int FROM ${shareRecipients}
              WHERE ${shareRecipients.shareSpaceId} = ${shareSpaces.id}
            )`,
            itemCount: sql<number>`(
              SELECT count(*)::int FROM ${shareItems}
              WHERE ${shareItems.shareSpaceId} = ${shareSpaces.id}
            )`,
          })
          .from(shareSpaces)
          .where(and(...conditions))
          .orderBy(desc(shareSpaces.createdAt), desc(shareSpaces.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        shareSpaceCursor.encode(item.createdAtCursor, item.id),
    });

    return Result.ok({
      ...page,
      items: page.items.map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        downloadPolicy: item.downloadPolicy,
        expiresAt: item.expiresAt?.toISOString() ?? null,
        revokedAt: item.revokedAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(),
        recipientCount: item.recipientCount,
        itemCount: item.itemCount,
      })),
    });
  },
);

export default listShareSpaces;
