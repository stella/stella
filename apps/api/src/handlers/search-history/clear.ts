import { Result } from "better-result";
import { and, count, eq } from "drizzle-orm";

import { searchHistoryEntries } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { searchHistoryAuditEvent } from "@/api/lib/audit-log";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

import {
  assertSearchHistoryScope,
  searchHistoryScopeQuery,
} from "./scope-precondition";

const config = {
  realtime: noResourceSetUpdates(
    "Personal history refreshes through the caller-owned query cache",
  ),
  description:
    "Delete your whole search history in the active organization: every search and opened decision or statute it holds. Entries are erased, not hidden; this cannot be undone. Your history in other organizations stays. Pass the scope from `search-history.list` to reject a changed sign-in scope; these fields never select a different owner.",
  query: searchHistoryScopeQuery,
  permissions: { searchHistory: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "personal_history",
    consumesServices: false,
  },
} satisfies HandlerConfig;

const clearSearchHistory = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, query, recordAuditEvent }) {
    yield* assertSearchHistoryScope({
      query,
      userId: user.id,
      organizationId: session.activeOrganizationId,
    });
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const deletedEntries = tx.$with("deleted_search_history").as(
          tx
            .delete(searchHistoryEntries)
            .where(
              and(
                eq(
                  searchHistoryEntries.organizationId,
                  session.activeOrganizationId,
                ),
                eq(searchHistoryEntries.userId, user.id),
              ),
            )
            .returning({ kind: searchHistoryEntries.kind }),
        );
        const groups = await tx
          .with(deletedEntries)
          .select({ kind: deletedEntries.kind, deleted: count() })
          .from(deletedEntries)
          .groupBy(deletedEntries.kind);
        let entryCount = 0;
        for (const group of groups) {
          entryCount += group.deleted;
        }
        await recordAuditEvent(
          tx,
          searchHistoryAuditEvent({
            resourceId: user.id,
            operation: "clear",
            entryCount,
            kinds: groups.map(({ kind }) => kind),
          }),
        );
        return entryCount;
      }),
    );
    return Result.ok({ deleted });
  },
);

declareAggregateMutation(clearSearchHistory.handler, {
  type: "independent",
  reason:
    "One delete of the caller's own entries in the organization; nothing else reads or counts them.",
});

export default clearSearchHistory;
