import { Result } from "better-result";
import { and, desc, eq, gt, max, min, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { searchHistoryEntries } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedSearchHistoryEntryId } from "@/api/lib/safe-id-boundaries";

import {
  searchHistoryCountrySchema,
  searchHistoryKindSchema,
  toSearchHistoryEntryResponse,
} from "./entries";

const config = {
  contract: "patch",
  description:
    "List your own search history in the active organization, most recently used first: law searches you ran and the decisions and statutes you opened. Each entry is private to you; nobody else in the organization can read it. Pass `kind` to list one kind, `country` to list one jurisdiction's entries, and `cursor` from `nextCursor` for older entries. Delete an entry with `search-history.delete`, or all of it with `search-history.clear`; pass the returned `scope.organizationId` as `expectedOrganizationId` and `scope.userId` as `expectedUserId` on either mutation.",
  permissions: { searchHistory: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    reason: "personal_history",
    consumesServices: false,
    readClass: "tenant",
  },
  query: v.object({
    kind: v.optional(searchHistoryKindSchema),
    country: v.optional(searchHistoryCountrySchema),
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      v.pipe(
        numberFromString(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(LIMITS.searchHistoryPageSizeMax),
          ),
        ),
        v.description(
          `Entries per page; ${LIMITS.searchHistoryPageSizeDefault} when omitted.`,
        ),
      ),
    ),
  }),
} satisfies HandlerConfig;

// Ownership columns constrain the read; lookup digests never leave storage.
const UNSELECTED_HISTORY_COLUMNS = [
  "organizationId",
  "userId",
  "lookupKey",
  "countryUsedAt",
  "baseLookupKey",
  "countryRepairFailedAt",
] as const satisfies readonly (keyof typeof searchHistoryEntries.$inferSelect)[];

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
    if (query.country !== undefined) {
      conditions.push(eq(searchHistoryEntries.country, query.country));
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
      safeDb((tx) => {
        const candidate = alias(
          searchHistoryEntries,
          "history_identity_candidate",
        );
        const sameIdentity = and(
          eq(candidate.organizationId, searchHistoryEntries.organizationId),
          eq(candidate.userId, searchHistoryEntries.userId),
          eq(candidate.kind, searchHistoryEntries.kind),
          sql`${candidate.country} IS NOT DISTINCT FROM ${searchHistoryEntries.country}`,
          sql`COALESCE(${candidate.baseLookupKey}, ${candidate.lookupKey}) = COALESCE(${searchHistoryEntries.baseLookupKey}, ${searchHistoryEntries.lookupKey})`,
        );
        const firstUse = tx
          .select({ value: min(candidate.firstUsedAt) })
          .from(candidate)
          .where(sameIdentity);
        const useCount = tx
          .select({ value: max(candidate.useCount) })
          .from(candidate)
          .where(sameIdentity);
        return tx
          .select({
            id: searchHistoryEntries.id,
            kind: searchHistoryEntries.kind,
            country: searchHistoryEntries.country,
            courtId: searchHistoryEntries.courtId,
            ciphertext: searchHistoryEntries.ciphertext,
            iv: searchHistoryEntries.iv,
            firstUsedAt: sql`(${firstUse})`.mapWith(
              searchHistoryEntries.firstUsedAt,
            ),
            lastUsedAt: searchHistoryEntries.lastUsedAt,
            useCount: sql`(${useCount})`.mapWith(Number),
            lastUsedAtCursor: searchHistoryCursor.cursorValue.as(
              "last_used_at_cursor",
            ),
          })
          .from(searchHistoryEntries)
          .where(
            and(
              ...conditions,
              notExists(
                tx
                  .select({ id: candidate.id })
                  .from(candidate)
                  .where(
                    and(
                      sameIdentity,
                      or(
                        sql`${candidate.lastUsedAt} > ${searchHistoryEntries.lastUsedAt}::timestamptz`,
                        and(
                          sql`${candidate.lastUsedAt} = ${searchHistoryEntries.lastUsedAt}::timestamptz`,
                          gt(candidate.id, searchHistoryEntries.id),
                        ),
                      ),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(
            desc(searchHistoryEntries.lastUsedAt),
            desc(searchHistoryEntries.id),
          )
          .limit(limit + 1);
      }),
    );
    type SelectedHistoryRow = Omit<(typeof rows)[number], "lastUsedAtCursor">;
    type UnselectedHistoryColumn = (typeof UNSELECTED_HISTORY_COLUMNS)[number];
    true satisfies UnprojectedColumns<
      typeof searchHistoryEntries.$inferSelect,
      SelectedHistoryRow,
      UnselectedHistoryColumn
    > extends never
      ? true
      : never;
    true satisfies UnbackedProjectionKeys<
      typeof searchHistoryEntries.$inferSelect,
      SelectedHistoryRow,
      UnselectedHistoryColumn
    > extends never
      ? true
      : never;

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
