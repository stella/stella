import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { searchHistoryEntries } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { searchHistoryAuditEvent } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Delete one entry from your own search history in the active organization. The entry is erased, not hidden; this cannot be undone. Take the id from `search-history.list`.",
  permissions: { searchHistory: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "personal_history",
    consumesServices: false,
  },
  params: t.Object({
    entryId: tSafeId("searchHistoryEntry", {
      description: "The entry's `id` from `search-history.list`.",
    }),
  }),
} satisfies HandlerConfig;

const deleteSearchHistoryEntry = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, user, recordAuditEvent }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
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
          });
        const row = rows.at(0);
        if (!row) {
          return null;
        }
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

declareAggregateMutation(deleteSearchHistoryEntry.handler, {
  type: "independent",
  reason:
    "One delete of the caller's own entry; nothing else reads or counts it.",
});

export default deleteSearchHistoryEntry;
