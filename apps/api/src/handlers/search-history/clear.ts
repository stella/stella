import { Result } from "better-result";
import { and, count, eq } from "drizzle-orm";
import { t } from "elysia";

import { searchHistoryEntries } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { searchHistoryAuditEvent } from "@/api/lib/audit-log";
import {
  tDefaultVarchar,
  tUserId,
  withDescription,
} from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Delete your whole search history in the active organization: every search and opened decision or statute it holds. Entries are erased, not hidden; this cannot be undone. Your history in other organizations stays. For a confirmation opened earlier, pass expectedOrganizationId and expectedUserId to reject a changed sign-in scope; these fields never select a different owner.",
  query: t.Object({
    expectedOrganizationId: t.Optional(
      withDescription(
        tDefaultVarchar,
        "The organization where this deletion was confirmed; a changed active organization rejects the request.",
      ),
    ),
    expectedUserId: t.Optional(
      withDescription(
        tUserId,
        "The user who confirmed this deletion; a changed signed-in user rejects the request.",
      ),
    ),
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
    if (
      (query.expectedOrganizationId !== undefined &&
        query.expectedOrganizationId !== session.activeOrganizationId) ||
      (query.expectedUserId !== undefined && query.expectedUserId !== user.id)
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "Your signed-in scope changed. Reopen search history and confirm clearing it again.",
        }),
      );
    }
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
