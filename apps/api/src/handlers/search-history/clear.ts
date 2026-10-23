import { Result } from "better-result";
import { and, count, eq, isNull, or, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  searchHistoryEntries,
  searchHistoryOwners,
  searchHistoryTombstones,
  SEARCH_HISTORY_KINDS,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { searchHistoryAuditEvent } from "@/api/lib/audit-log";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

import {
  fillOpenedDocumentJurisdictions,
  holdSearchHistoryOwnerAccess,
  lockSearchHistoryOwner,
  recordSearchHistoryTombstones,
  searchHistoryJurisdictionSchema,
} from "./entries";
import {
  assertSearchHistoryScope,
  searchHistoryScopeQuery,
} from "./scope-precondition";

const config = {
  contract: "patch",
  realtime: noResourceSetUpdates(
    "Personal history refreshes through the caller-owned query cache",
  ),
  description:
    "Delete your search history in the active organization: every search and opened decision or statute it holds, or with `jurisdiction` only what `search-history.list` lists for that country. Entries are erased, not hidden; this cannot be undone. Your history in other organizations stays. Pass the scope from `search-history.list` to reject a changed sign-in scope; these fields never select a different owner.",
  query: t.Object({
    ...searchHistoryScopeQuery.properties,
    jurisdiction: t.Optional(searchHistoryJurisdictionSchema),
  }),
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
        const owner = {
          organizationId: session.activeOrganizationId,
          userId: user.id,
        };
        await holdSearchHistoryOwnerAccess(tx, owner);
        await tx
          .insert(searchHistoryOwners)
          .values(owner)
          .onConflictDoNothing();
        await lockSearchHistoryOwner(tx, owner);
        if (query.jurisdiction !== undefined) {
          // Other countries' history stays, so there is no owner-wide import
          // cutoff: each erased entry gets its own tombstone instead.
          await fillOpenedDocumentJurisdictions(tx, owner);
          const erased = await tx
            .delete(searchHistoryEntries)
            .where(
              and(
                eq(
                  searchHistoryEntries.organizationId,
                  session.activeOrganizationId,
                ),
                eq(searchHistoryEntries.userId, user.id),
                or(
                  eq(searchHistoryEntries.jurisdiction, query.jurisdiction),
                  isNull(searchHistoryEntries.jurisdiction),
                ),
              ),
            )
            .returning({
              kind: searchHistoryEntries.kind,
              lookupKey: searchHistoryEntries.lookupKey,
            });
          await recordSearchHistoryTombstones(tx, owner, erased);
          await recordAuditEvent(
            tx,
            searchHistoryAuditEvent({
              resourceId: user.id,
              operation: "clear",
              entryCount: erased.length,
              kinds: SEARCH_HISTORY_KINDS.filter((kind) =>
                erased.some((row) => row.kind === kind),
              ),
            }),
          );
          return erased.length;
        }
        await tx
          .update(searchHistoryOwners)
          .set({
            clearedAt: sql`GREATEST(${searchHistoryOwners.clearedAt}, clock_timestamp())`,
          })
          .where(
            and(
              eq(
                searchHistoryOwners.organizationId,
                session.activeOrganizationId,
              ),
              eq(searchHistoryOwners.userId, user.id),
            ),
          );
        // The newer clear cutoff replaces every earlier per-entry cutoff.
        await tx
          .delete(searchHistoryTombstones)
          .where(
            and(
              eq(
                searchHistoryTombstones.organizationId,
                session.activeOrganizationId,
              ),
              eq(searchHistoryTombstones.userId, user.id),
            ),
          );

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
    "Owner-serialized clear records its import cutoff and deletes the entries in one audited transaction.",
});

export default clearSearchHistory;
