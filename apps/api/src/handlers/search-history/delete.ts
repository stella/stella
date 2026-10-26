import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { searchHistoryEntries, searchHistoryOwners } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { searchHistoryAuditEvent } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

import {
  holdSearchHistoryOwnerAccess,
  lockSearchHistoryOwner,
  recordSearchHistoryTombstones,
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
  query: searchHistoryScopeQuery,
  description:
    "Delete one entry from your own search history in the active organization. The entry is erased, not hidden; this cannot be undone. Take the id and scope from `search-history.list`. A changed sign-in scope rejects the request.",
  permissions: { searchHistory: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "personal_history",
    consumesServices: false,
  },
  params: v.object({
    entryId: resourceIdSchema("searchHistoryEntry", {
      description: "The entry's `id` from `search-history.list`.",
    }),
  }),
} satisfies HandlerConfig;

const deleteSearchHistoryEntry = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, user, query, recordAuditEvent }) {
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

        const rows = await tx
          .delete(searchHistoryEntries)
          .where(
            and(
              eq(searchHistoryEntries.id, params.entryId),
              eq(
                searchHistoryEntries.organizationId,
                session.activeOrganizationId,
              ),
              eq(searchHistoryEntries.userId, user.id),
            ),
          )
          .returning({
            id: searchHistoryEntries.id,
            kind: searchHistoryEntries.kind,
            lookupKey: searchHistoryEntries.lookupKey,
          });
        const row = rows.at(0);
        if (!row) {
          return null;
        }
        await recordSearchHistoryTombstones(tx, owner, [row]);
        await recordAuditEvent(
          tx,
          searchHistoryAuditEvent({
            resourceId: row.id,
            operation: "delete",
            entryCount: 1,
            kinds: [row.kind],
          }),
        );
        return { id: row.id };
      }),
    );
    if (!deleted) {
      return Result.err(
        new HandlerError({
          status: 404,
          message:
            "Search history entry not found: list your history with `search-history.list` for current ids.",
        }),
      );
    }
    return Result.ok({ id: deleted.id });
  },
);

declareAggregateMutation(deleteSearchHistoryEntry, {
  type: "independent",
  reason:
    "Owner-serialized delete records an identity cutoff and erases the entry in one audited transaction.",
});

export default deleteSearchHistoryEntry;
