import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { foldText } from "@/state/palette";
import { searchText } from "@/state/search";

/** The person's own recent searches, which the web records. */
const SEARCH_HISTORY_PATH = "/v1/search-history";

/** The most recent searches the screen lists. */
export const RECENT_SEARCHES_LIMIT = 10;

/** A search the person ran, and when, in epoch milliseconds. */
export type RecentSearch = { readonly query: string; readonly usedAt: number };

/**
 * What the device keeps for one account: the searches run in the app, and
 * when the list was last cleared, before which the server's own entries
 * stay hidden.
 */
const storedRecentsSchema = v.object({
  recents: v.array(v.object({ query: v.string(), usedAt: v.number() })),
  clearedAt: v.nullable(v.number()),
});

export type StoredRecents = v.InferOutput<typeof storedRecentsSchema>;

export const NO_RECENTS: StoredRecents = { recents: [], clearedAt: null };

/** Reads and writes one account's small values on the device, by key. */
export type AccountStore = {
  readonly read: (key: string) => Promise<string | null>;
  readonly write: (key: string, value: string) => Promise<void>;
};

/**
 * One part of a key in the characters the platform keychain accepts:
 * letters and digits stay, anything else becomes `_` and its code point in
 * six hex digits, so two different parts never meet in one key.
 */
const keyPart = (part: string): string =>
  part.replaceAll(
    /[^A-Za-z0-9]/gu,
    (character) =>
      `_${(character.codePointAt(0) ?? 0).toString(16).padStart(6, "0")}`,
  );

/** The device key of one account's recent searches: its server and its person. */
export const recentSearchesKey = (serverUrl: string, userId: string): string =>
  `stella.recent-searches.${keyPart(serverUrl)}.${keyPart(userId)}`;

/** What the device kept, or none when it kept nothing this build can read. */
export const readStoredRecents = (stored: string | null): StoredRecents => {
  if (stored === null) {
    return NO_RECENTS;
  }
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), storedRecentsSchema),
    stored,
  );
  return parsed.success ? parsed.output : NO_RECENTS;
};

/** The same search typed twice, in another case or without its accents. */
const sameSearch = (query: string) => foldText(searchText(query));

/** The kept searches with `query` on top, an earlier run of it dropped, capped. */
export const rememberSearch = (
  stored: StoredRecents,
  query: string,
  usedAt: number,
): StoredRecents => {
  const text = searchText(query);
  if (text === "") {
    return stored;
  }
  const folded = sameSearch(text);
  return {
    ...stored,
    recents: [
      { query: text, usedAt },
      ...stored.recents.filter((recent) => sameSearch(recent.query) !== folded),
    ].slice(0, RECENT_SEARCHES_LIMIT),
  };
};

/** No searches kept, and the server's up to `clearedAt` hidden. */
export const clearRecents = (clearedAt: number): StoredRecents => ({
  recents: [],
  clearedAt,
});

// A copy sorted in place: Hermes, the app's engine, lacks `toSorted`.
const newestFirst = (searches: readonly RecentSearch[]): RecentSearch[] =>
  [...searches].sort((left, right) => right.usedAt - left.usedAt);

/**
 * The searches the screen lists: the ones run in the app, newest first,
 * then the server's, newest first, without those cleared on this device.
 * The same search appears once, where it first does, and the list stops at
 * `limit`.
 */
export const mergeRecentSearches = (
  stored: StoredRecents,
  server: readonly RecentSearch[],
  limit: number = RECENT_SEARCHES_LIMIT,
): string[] => {
  const { clearedAt } = stored;
  const shown = server.filter(
    (search) => clearedAt === null || search.usedAt > clearedAt,
  );
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const { query } of [
    ...newestFirst(stored.recents),
    ...newestFirst(shown),
  ]) {
    const folded = sameSearch(query);
    if (folded !== "" && !seen.has(folded)) {
      seen.add(folded);
      merged.push(searchText(query));
    }
  }
  return merged.slice(0, limit);
};

/**
 * An entry of the server's history. Only typed searches are read: an opened
 * decision or statute is not something to search again.
 */
const historyEntrySchema = v.object({
  kind: v.string(),
  query: v.nullish(v.string()),
  lastUsedAt: v.string(),
});

const historyPageSchema = v.object({ items: v.array(historyEntrySchema) });

/** Epoch milliseconds of an ISO instant, or null for one that does not parse. */
const epochOf = (instant: string): number | null =>
  Result.try(() => Temporal.Instant.from(instant).epochMilliseconds).unwrapOr(
    null,
  );

/** The searches the person ran most recently, as the server recorded them. */
export const listServerRecentSearches = async ({
  fetch,
  source,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<RecentSearch[], ApiError>> => {
  const answer = await requestApi({
    fetch,
    path: `${SEARCH_HISTORY_PATH}?kind=search&limit=${RECENT_SEARCHES_LIMIT}`,
    schema: historyPageSchema,
    source,
  });
  return answer.map((page) =>
    page.items.flatMap(({ kind, lastUsedAt, query }) => {
      const usedAt = epochOf(lastUsedAt);
      return kind === "search" &&
        query !== null &&
        query !== undefined &&
        usedAt !== null
        ? [{ query, usedAt }]
        : [];
    }),
  );
};
