import { Result } from "better-result";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import {
  canonicalSearchHistoryEntry,
  prepareSearchHistoryImportRows,
  readSearchHistoryEntryInput,
  upsertSearchHistoryRows,
} from "./entries";
import type { SearchHistoryUse } from "./entries";
import {
  readSearchHistoryDatabaseClock,
  searchHistoryImportClockSchema,
  verifySearchHistoryImportClock,
} from "./import-clock";
import { readImportClock, readImportUsedAt } from "./import-used-at";
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
      clock: searchHistoryImportClockSchema,
      clientNow: t.String({
        format: "date-time",
        maxLength: 64,
        description:
          "The importing device's current clock, captured after obtaining clock from search-history/import-clock and immediately before sending this request. Used to correct entry timestamps; clocks differing by more than one day are rejected.",
      }),
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
    const clock = readImportClock(body.clientNow, now);
    if (clock === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Search history import requires a valid current device time within one day of the server clock. Correct the device clock and retry.",
        }),
      );
    }
    const databaseNow = yield* Result.await(
      safeDb(readSearchHistoryDatabaseClock),
    );
    const issuedAtMs = yield* Result.await(
      verifySearchHistoryImportClock({
        organizationId: session.activeOrganizationId,
        userId: user.id,
        clock: body.clock,
        databaseNow,
      }),
    );
    // D spans the signed DB-clock issuance through receipt; clientNow is
    // captured inside that interval. Subtracting D gives usedAt+issuedAt-clientNow,
    // so cutoff eligibility never relies on a request-duration assumption.
    const importClockMarginMs = clock.serverNowMs - issuedAtMs;
    const uses: SearchHistoryUse[] = [];
    for (const kept of body.entries) {
      const entry = readSearchHistoryEntryInput(kept.entry);
      const usedAt = readImportUsedAt(kept.usedAt, clock);
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
          await prepareSearchHistoryImportRows(
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
            importClockMarginMs,
            recordAuditEvent,
          }),
      ),
    );
    return Result.ok({
      entries: written.entries.length,
      skipped: body.entries.length - uses.length + written.skipped,
      rejected: body.entries.length - uses.length,
    });
  },
);

declareAggregateMutation(importSearchHistory.handler, {
  type: "independent",
  reason:
    "One batched upsert on the unique owner lookup key; a repeated or concurrent import converges in the database.",
});

export default importSearchHistory;
