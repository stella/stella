import { Result } from "better-result";

import { abortableTx } from "@/api/db/safe-db";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  prepareSearchHistoryRows,
  searchHistoryEntryInputSchema,
  upsertSearchHistoryRows,
} from "./entries";
import {
  assertSearchHistoryScope,
  searchHistoryScopeQuery,
} from "./scope-precondition";

const config = {
  query: searchHistoryScopeQuery,
  permissions: { searchHistory: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // The law pages record a use as it happens; agents read and delete history.
  mcp: { type: "internal", reason: "search_ui" },
  body: searchHistoryEntryInputSchema,
} satisfies HandlerConfig;

/** Records one use: a new entry, or a bump of the caller's matching one. */
const upsertSearchHistory = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, query, recordAuditEvent }) {
    yield* assertSearchHistoryScope({
      query,
      userId: user.id,
      organizationId: session.activeOrganizationId,
    });
    const rows = yield* Result.await(
      Result.tryPromise(
        async () =>
          await prepareSearchHistoryRows(
            { organizationId: session.activeOrganizationId, userId: user.id },
            [{ entry: body, usedAt: new Date() }],
          ),
      ),
    );
    if (rows.length === 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Nothing to record: a search needs a query, and an opened entry a decision or statute page.",
        }),
      );
    }
    const written = yield* Result.await(
      abortableTx(
        safeDb,
        async (tx) =>
          await upsertSearchHistoryRows({
            tx,
            rows,
            mode: "record",
            recordAuditEvent,
          }),
      ),
    );
    const entry = written.entries.at(0);
    if (!entry) {
      return Result.err(
        new HandlerError({ status: 500, message: "Entry was not recorded" }),
      );
    }
    return Result.ok({ id: entry.id });
  },
);

declareAggregateMutation(upsertSearchHistory.handler, {
  type: "independent",
  reason:
    "One upsert on the unique owner lookup key; concurrent records of one entry converge in the database.",
});

export default upsertSearchHistory;
