import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { searchHistoryEntries } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedSearchHistoryEntryId } from "@/api/lib/safe-id-boundaries";

import {
  searchHistoryKindSchema,
  toSearchHistoryEntryResponse,
} from "./entries";

const config = {
  description:
    "List your own search history in the active organization, most recently used first: law searches you ran and the decisions and statutes you opened. Each entry is private to you; nobody else in the organization can read it. Pass `kind` to list one kind, and `cursor` from `nextCursor` for older entries. Delete an entry with `search-history.delete`, or all of it with `search-history.clear`; pass the returned `scope.organizationId` as `expectedOrganizationId` and `scope.userId` as `expectedUserId` on either mutation.",
  permissions: { searchHistory: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    reason: "personal_history",
    consumesServices: false,
    readClass: "tenant",
  },
  query: t.Object({
    kind: t.Optional(searchHistoryKindSchema),
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.searchHistoryPageSizeMax,
        description: `Entries per page; ${LIMITS.searchHistoryPageSizeDefault} when omitted.`,
      }),
    ),
  }),
} satisfies HandlerConfig;

const searchHistoryCursor = createTimestampIdCursorCodec({
  column: searchHistoryEntries.lastUsedAt,
  brandId: brandPersistedSearchHistoryEntryId,
});

const listSearchHistory = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.searchHistoryPageSizeDefault,
    );
    const organizationId = session.activeOrganizationId;
    const conditions = [
      eq(searchHistoryEntries.organizationId, organizationId),
      eq(searchHistoryEntries.userId, user.id),
    ];
    if (query.kind !== undefined) {
      conditions.push(eq(searchHistoryEntries.kind, query.kind));
    }
    if (query.cursor !== undefined) {
      const cursor = searchHistoryCursor.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "Invalid cursor: list search history again without `cursor` to start from the latest entry.",
          }),
        );
      }
      const after = searchHistoryCursor.keysetAfter({
        cursor,
        idColumn: searchHistoryEntries.id,
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
            id: searchHistoryEntries.id,
            kind: searchHistoryEntries.kind,
            courtId: searchHistoryEntries.courtId,
            ciphertext: searchHistoryEntries.ciphertext,
            iv: searchHistoryEntries.iv,
            firstUsedAt: searchHistoryEntries.firstUsedAt,
            lastUsedAt: searchHistoryEntries.lastUsedAt,
            useCount: searchHistoryEntries.useCount,
            lastUsedAtCursor: searchHistoryCursor.cursorValue.as(
              "last_used_at_cursor",
            ),
          })
          .from(searchHistoryEntries)
          .where(and(...conditions))
          .orderBy(
            desc(searchHistoryEntries.lastUsedAt),
            desc(searchHistoryEntries.id),
          )
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        searchHistoryCursor.encode(item.lastUsedAtCursor, item.id),
    });
    const items = yield* Result.await(
      Result.tryPromise(
        async () =>
          await Promise.all(
            page.items.map(
              async (row) =>
                await toSearchHistoryEntryResponse(organizationId, row),
            ),
          ),
      ),
    );

    return Result.ok({
      ...page,
      items,
      scope: { organizationId, userId: user.id },
    });
  },
);

export default listSearchHistory;
