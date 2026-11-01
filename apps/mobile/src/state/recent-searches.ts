import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import type { BeforeSessionEnd } from "@/connection/session-end";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { foldText } from "@/state/palette";
import { searchText } from "@/state/search";

/** The person's own recent searches, which the web records. */
const SEARCH_HISTORY_PATH = "/v1/search-history";

/** The most recent searches the screen lists. */
export const RECENT_SEARCHES_LIMIT = 10;

/** The longest search the device keeps, in characters; a longer one is cut. */
export const SAVED_QUERY_MAX_LENGTH = 100;

/**
 * The most the kept list takes once written, in UTF-8 bytes: the platform
 * keychain store may refuse a value over 2048 bytes.
 */
export const SAVED_RECENTS_MAX_BYTES = 2000;

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
  readonly remove: (key: string) => Promise<void>;
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

/**
 * The device key of one account's recent searches: its server and its
 * person. The session keeps no organization id on the device, so an account
 * in several organizations on one server keeps one list for all of them.
 */
export const recentSearchesKey = (serverUrl: string, userId: string): string =>
  `recent-searches.${keyPart(serverUrl)}.${keyPart(userId)}`;

/**
 * Deletes the ending session's recent searches from the device, so a
 * signed-out account leaves none of its searches behind.
 */
export const forgetRecentSearches =
  (store: AccountStore): BeforeSessionEnd =>
  async (_reason, session) => {
    await store.remove(recentSearchesKey(session.serverUrl, session.userId));
  };

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

/** The kept list as the device writes it. */
export const serializeRecents = (stored: StoredRecents): string =>
  JSON.stringify(stored);

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

/** The kept list without its oldest searches until it fits the keychain. */
const fitForDevice = (stored: StoredRecents): StoredRecents => {
  for (let count = stored.recents.length; count > 0; count -= 1) {
    const fitted = { ...stored, recents: stored.recents.slice(0, count) };
    if (byteLength(serializeRecents(fitted)) <= SAVED_RECENTS_MAX_BYTES) {
      return fitted;
    }
  }
  return { ...stored, recents: [] };
};

/**
 * The kept searches with `query` on top, cut to the length the device keeps,
 * an earlier run of it dropped, and the oldest dropped past the limit or
 * once the list outgrows what the keychain takes.
 */
export const rememberSearch = (
  stored: StoredRecents,
  query: string,
  usedAt: number,
): StoredRecents => {
  // Cut by code points, so a character outside the basic plane stays whole.
  const text = Array.from(searchText(query))
    .slice(0, SAVED_QUERY_MAX_LENGTH)
    .join("")
    .trim();
  if (text === "") {
    return stored;
  }
  const folded = sameSearch(text);
  return fitForDevice({
    ...stored,
    recents: [
      { query: text, usedAt },
      ...stored.recents.filter((recent) => sameSearch(recent.query) !== folded),
    ].slice(0, RECENT_SEARCHES_LIMIT),
  });
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
  // Best effort: `clearedAt` is the device's clock and `usedAt` the server's,
  // so a skew between them shows or hides an entry used around the clearing.
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

/** Changes one account's recent searches; each resolves once written. */
export type RecentSearches = {
  readonly remember: (query: string) => Promise<void>;
  readonly clear: () => Promise<void>;
  /** Settles once the device's list and the server's have both loaded. */
  readonly ready: Promise<void>;
};

/**
 * One account's recent searches while the screen is open. The device's list
 * loads on its own, never waiting on the network. A search remembered, or a
 * clearing, waits for that read and the changes before it, so nothing is
 * written over a list not yet read. The server's entries join whenever they
 * arrive, once the device's list is there to hide the cleared ones.
 */
export const openRecentSearches = ({
  key,
  loadServer,
  now,
  onChange,
  store,
}: {
  readonly key: string;
  readonly loadServer: () => Promise<Result<RecentSearch[], ApiError>>;
  readonly now: () => number;
  /** Called with the searches to list each time they change. */
  readonly onChange: (searches: string[]) => void;
  readonly store: AccountStore;
}): RecentSearches => {
  // Set by the device read below; the closures read it as it is then.
  let stored = null as StoredRecents | null;
  let server: readonly RecentSearch[] = [];
  const show = (kept: StoredRecents) => {
    onChange(mergeRecentSearches(kept, server));
  };
  const deviceRead = (async () => {
    const kept = readStoredRecents(await store.read(key).catch(() => null));
    stored = kept;
    show(kept);
  })();
  const serverRead = (async () => {
    // The server's list is a nicety: a load that throws lists none.
    const recorded = await loadServer().catch(
      (): Result<RecentSearch[], ApiError> => Result.ok([]),
    );
    server = recorded.unwrapOr([]);
    if (stored !== null) {
      show(stored);
    }
  })();
  // Every change runs after the device read and the changes queued before it.
  let queue: Promise<void> = deviceRead;
  const change = async (update: (kept: StoredRecents) => StoredRecents) => {
    const previous = queue;
    const run = (async () => {
      await previous;
      const kept = update(stored ?? NO_RECENTS);
      stored = kept;
      show(kept);
      // Best effort: a search not written is only missing after a restart.
      await store.write(key, serializeRecents(kept)).catch(() => undefined);
    })();
    queue = run;
    await run;
  };
  return {
    ready: (async () => {
      await Promise.all([deviceRead, serverRead]);
    })(),
    remember: async (query) => {
      await change((kept) => rememberSearch(kept, query, now()));
    },
    clear: async () => {
      await change(() => clearRecents(now()));
    },
  };
};
