import { Result } from "better-result";
import { t } from "elysia";

import { Temporal } from "@stll/time";

import { abortableTx } from "@/api/db/safe-db";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { LIMITS } from "@/api/lib/limits";

import {
  canonicalSearchHistoryEntry,
  prepareSearchHistoryRows,
  readSearchHistoryEntryInput,
  upsertSearchHistoryRows,
} from "./entries";
import type { SearchHistoryUse } from "./entries";
import {
  assertSearchHistoryScope,
  searchHistoryScopeQuery,
} from "./scope-precondition";

const config = {
  query: searchHistoryScopeQuery,
  permissions: { searchHistory: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // A browser hands over what it kept locally, once; not an agent action.
  mcp: { type: "internal", reason: "search_ui" },
  body: t.Object(
    {
      entries: t.Array(
        t.Object(
          {
            // Checked entry by entry below: one stale local row must not
            // sink the rest of the import.
            entry: t.Unknown(),
            usedAt: t.String({ maxLength: 64 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: LIMITS.searchHistoryImportMax },
      ),
    },
    { additionalProperties: false },
  ),
} satisfies HandlerConfig;

/** When a kept entry was last used, never later than now. */
const readUsedAt = (value: string, now: Date): Date | null =>
  Result.try(() => Temporal.Instant.from(value))
    .map(
      (instant) => new Date(Math.min(instant.epochMilliseconds, now.getTime())),
    )
    .unwrapOr(null);

/**
 * Takes in the history a browser kept before it was stored here, in one call.
 * Entries merge into the caller's own like any other use, so a repeated
 * import (a second tab, a retry) preserves counts without duplicate entries.
 * Entries that do not read as history are skipped and counted.
 */
const importSearchHistory = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, query, recordAuditEvent }) {
    yield* assertSearchHistoryScope({
      query,
      userId: user.id,
      organizationId: session.activeOrganizationId,
    });
    const now = new Date();
    const uses: SearchHistoryUse[] = [];
    for (const kept of body.entries) {
      const entry = readSearchHistoryEntryInput(kept.entry);
      const usedAt = readUsedAt(kept.usedAt, now);
      if (
        entry !== null &&
        usedAt !== null &&
        canonicalSearchHistoryEntry(entry) !== null
      ) {
        uses.push({ entry, usedAt });
      }
    }
    const rows = yield* Result.await(
      Result.tryPromise(
        async () =>
          await prepareSearchHistoryRows(
            { organizationId: session.activeOrganizationId, userId: user.id },
            uses,
          ),
      ),
    );
    const written = yield* Result.await(
      abortableTx(
        safeDb,
        async (tx) =>
          await upsertSearchHistoryRows({
            tx,
            rows,
            mode: "import",
            recordAuditEvent,
          }),
      ),
    );
    return Result.ok({
      entries: written.length,
      skipped: body.entries.length - uses.length,
    });
  },
);

declareAggregateMutation(importSearchHistory.handler, {
  type: "independent",
  reason:
    "One batched upsert on the unique owner lookup key; a repeated or concurrent import converges in the database.",
});

export default importSearchHistory;
