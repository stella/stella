import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  type StoredSession,
} from "@/connection/session";

import {
  clearRecents,
  listServerRecentSearches,
  mergeRecentSearches,
  NO_RECENTS,
  openRecentSearches,
  readStoredRecents,
  RECENT_SEARCHES_LIMIT,
  recentSearchesKey,
  rememberSearch,
  SAVED_QUERY_MAX_LENGTH,
  SAVED_RECENTS_MAX_BYTES,
  serializeRecents,
} from "./recent-searches";
import type {
  AccountStore,
  RecentSearch,
  StoredRecents,
} from "./recent-searches";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const sourceFor = (fetch: Fetch) =>
  createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store: {
      read: async () => SESSION,
      write: async () => {},
      clear: async () => {},
    },
  });

type Sent = { url: string; method: string };

const recording = (answer: unknown) => {
  const sent: Sent[] = [];
  const fetch: Fetch = async (input, init) => {
    sent.push({ url: input, method: init?.method ?? "GET" });
    return Response.json(answer);
  };
  return { fetch, sent };
};

const kept = (
  recents: { query: string; usedAt: number }[],
  clearedAt: number | null = null,
): StoredRecents => ({ recents, clearedAt });

describe("where the device keeps an account's recent searches", () => {
  test("a key in the keychain's characters, one per server and person", () => {
    const key = recentSearchesKey("https://stella.example.com", "user-1");
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(
      new Set([
        key,
        recentSearchesKey("https://stella.example.com", "user-2"),
        recentSearchesKey("https://other.example.com", "user-1"),
      ]).size,
    ).toBe(3);
  });

  test("two accounts never share a key, however their parts are split", () => {
    expect(recentSearchesKey("https://a.example", "b.c")).not.toBe(
      recentSearchesKey("https://a.example.b", "c"),
    );
    // U+1F60 then "0" against U+1F600: a code point's digits run fixed width.
    expect(
      recentSearchesKey("x", String.fromCodePoint(0x1f_60, 0x30)),
    ).not.toBe(recentSearchesKey("x", String.fromCodePoint(0x1_f6_00)));
  });

  test("what was kept reads back, and anything unreadable as nothing", () => {
    const stored = kept([{ query: "lease", usedAt: 5 }], 2);
    expect(readStoredRecents(JSON.stringify(stored))).toEqual(stored);
    expect(readStoredRecents(null)).toEqual(NO_RECENTS);
    expect(readStoredRecents("not json")).toEqual(NO_RECENTS);
    expect(readStoredRecents('{"recents":"lease"}')).toEqual(NO_RECENTS);
  });
});

describe("remembering a search", () => {
  test("puts it on top, trimmed, and drops an earlier run of the same search", () => {
    const stored = kept([
      { query: "Lease", usedAt: 1 },
      { query: "deposit", usedAt: 2 },
    ]);
    expect(rememberSearch(stored, "  lease ", 3)).toEqual(
      kept([
        { query: "lease", usedAt: 3 },
        { query: "deposit", usedAt: 2 },
      ]),
    );
  });

  test("treats a search typed without its accents as the same one", () => {
    const stored = kept([{ query: "Žaloba", usedAt: 1 }]);
    expect(rememberSearch(stored, "zaloba", 2).recents).toEqual([
      { query: "zaloba", usedAt: 2 },
    ]);
  });

  test("ignores a blank search and keeps no more than the list shows", () => {
    expect(rememberSearch(NO_RECENTS, "   ", 1)).toBe(NO_RECENTS);
    let stored = NO_RECENTS;
    for (let index = 0; index < RECENT_SEARCHES_LIMIT + 3; index += 1) {
      stored = rememberSearch(stored, `query ${index}`, index);
    }
    expect(stored.recents).toHaveLength(RECENT_SEARCHES_LIMIT);
    expect(stored.recents[0]?.query).toBe(`query ${RECENT_SEARCHES_LIMIT + 2}`);
  });
});

describe("what the device writes", () => {
  test("keeps each search to the saved length, whole characters only", () => {
    const long = `${"a".repeat(SAVED_QUERY_MAX_LENGTH - 1)}😀 tail`;
    const [saved] = rememberSearch(NO_RECENTS, long, 1).recents;
    expect(saved?.query).toBe(`${"a".repeat(SAVED_QUERY_MAX_LENGTH - 1)}😀`);
  });

  test("stays within what the keychain takes at the longest input, dropping the oldest first", () => {
    let stored = clearRecents(Number.MAX_SAFE_INTEGER);
    for (let index = 0; index < RECENT_SEARCHES_LIMIT; index += 1) {
      // Three UTF-8 bytes a character, and a quote JSON escapes.
      stored = rememberSearch(
        stored,
        `${index}"${"€".repeat(SAVED_QUERY_MAX_LENGTH)}`,
        Number.MAX_SAFE_INTEGER - index,
      );
    }
    const written = new TextEncoder().encode(serializeRecents(stored)).length;
    expect(written).toBeLessThanOrEqual(SAVED_RECENTS_MAX_BYTES);
    expect(stored.recents.length).toBeGreaterThan(0);
    expect(
      stored.recents[0]?.query.startsWith(`${RECENT_SEARCHES_LIMIT - 1}"`),
    ).toBe(true);
    expect(readStoredRecents(serializeRecents(stored))).toEqual(stored);
  });
});

describe("the recent searches listed", () => {
  test("are the device's newest first, then the server's newest first, each once", () => {
    const stored = kept([
      { query: "deposit", usedAt: 10 },
      { query: "lease", usedAt: 30 },
    ]);
    const server = [
      { query: "notice period", usedAt: 5 },
      { query: "LEASE", usedAt: 40 },
      { query: "sublease", usedAt: 20 },
    ];
    expect(mergeRecentSearches(stored, server)).toEqual([
      "lease",
      "deposit",
      "sublease",
      "notice period",
    ]);
  });

  test("stop at the limit", () => {
    const server = Array.from({ length: 15 }, (_, index) => ({
      query: `query ${index}`,
      usedAt: index,
    }));
    expect(mergeRecentSearches(NO_RECENTS, server, 3)).toEqual([
      "query 14",
      "query 13",
      "query 12",
    ]);
    expect(mergeRecentSearches(NO_RECENTS, server)).toHaveLength(
      RECENT_SEARCHES_LIMIT,
    );
  });

  test("after clearing, leave out the device's and the server's from before, not the server's since", () => {
    const cleared = clearRecents(100);
    expect(cleared).toEqual(kept([], 100));
    expect(
      mergeRecentSearches(cleared, [
        { query: "before", usedAt: 90 },
        { query: "at the clearing", usedAt: 100 },
        { query: "since", usedAt: 110 },
      ]),
    ).toEqual(["since"]);
  });

  test("a search remembered after clearing lists again", () => {
    expect(
      mergeRecentSearches(rememberSearch(clearRecents(100), "lease", 120), [
        { query: "deposit", usedAt: 50 },
      ]),
    ).toEqual(["lease"]);
  });
});

describe("the server's recent searches", () => {
  test("are read from the search history, typed searches only", async () => {
    const { fetch, sent } = recording({
      items: [
        {
          id: "history-1",
          kind: "search",
          country: "CZE",
          query: "lease",
          firstUsedAt: "2026-09-01T08:00:00.000Z",
          lastUsedAt: "2026-10-01T08:00:00.000Z",
          useCount: 3,
        },
        {
          id: "history-2",
          kind: "decision",
          country: "CZE",
          documentId: "decision-1",
          title: "1 Abc 23/2024",
          path: "/law/cze/decision-1",
          firstUsedAt: "2026-09-02T08:00:00.000Z",
          lastUsedAt: "2026-09-02T08:00:00.000Z",
          useCount: 1,
        },
        {
          id: "history-3",
          kind: "search",
          country: null,
          query: "deposit",
          firstUsedAt: "2026-09-03T08:00:00.000Z",
          lastUsedAt: "not a time",
          useCount: 1,
        },
      ],
      nextCursor: null,
      scope: { organizationId: "org-1", userId: "user-1" },
    });
    const searches = await listServerRecentSearches({
      fetch,
      source: sourceFor(fetch),
    });
    expect(sent).toEqual([
      {
        url: `https://stella.example.com/v1/search-history?kind=search&limit=${RECENT_SEARCHES_LIMIT}`,
        method: "GET",
      },
    ]);
    expect(searches.isOk() ? searches.value : null).toEqual([
      {
        query: "lease",
        usedAt: Temporal.Instant.from("2026-10-01T08:00:00.000Z")
          .epochMilliseconds,
      },
    ]);
  });
});

/** A promise and the means to settle it from the test. */
const deferred = <T>() => {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
};

/**
 * A device store holding one value, recording what is written to it and,
 * in `events`, when its read returned and each write began.
 */
const deviceWith = (value: string | null, read?: Promise<void>) => {
  const writes: string[] = [];
  const events: string[] = [];
  const store: AccountStore = {
    read: async () => {
      await read;
      events.push("read");
      return value;
    },
    write: async (_key, next) => {
      events.push("write");
      await Promise.resolve();
      writes.push(next);
    },
  };
  return { events, store, writes };
};

const opened = ({
  device,
  server,
  now,
}: {
  device: ReturnType<typeof deviceWith>;
  server: Promise<RecentSearch[]>;
  now: number;
}) => {
  const shown: string[][] = [];
  const recents = openRecentSearches({
    key: "key-1",
    loadServer: async () => Result.ok(await server),
    now: () => now,
    onChange: (searches) => {
      shown.push(searches);
    },
    store: device.store,
  });
  return { recents, shown };
};

describe("recent searches while the screen is open", () => {
  test("a search remembered before the server answers keeps the device's earlier ones", async () => {
    const device = deviceWith(
      serializeRecents(kept([{ query: "deposit", usedAt: 10 }])),
    );
    const server = deferred<RecentSearch[]>();
    const { recents, shown } = opened({
      device,
      server: server.promise,
      now: 50,
    });

    await recents.remember("lease");
    expect(device.writes.map((written) => readStoredRecents(written))).toEqual([
      kept([
        { query: "lease", usedAt: 50 },
        { query: "deposit", usedAt: 10 },
      ]),
    ]);
    expect(shown.at(-1)).toEqual(["lease", "deposit"]);

    server.resolve([{ query: "notice period", usedAt: 20 }]);
    await recents.ready;
    expect(shown.at(-1)).toEqual(["lease", "deposit", "notice period"]);
    expect(device.writes).toHaveLength(1);
  });

  test("nothing is written before the device's list is read", async () => {
    const read = deferred<undefined>();
    const device = deviceWith(
      serializeRecents(kept([{ query: "deposit", usedAt: 10 }])),
      read.promise,
    );
    const { recents, shown } = opened({
      device,
      server: Promise.resolve([]),
      now: 50,
    });

    const remembering = recents.remember("lease");
    expect(shown).toEqual([]);
    read.resolve(undefined);
    await remembering;
    expect(device.events).toEqual(["read", "write"]);
    expect(device.writes.map((written) => readStoredRecents(written))).toEqual([
      kept([
        { query: "lease", usedAt: 50 },
        { query: "deposit", usedAt: 10 },
      ]),
    ]);
    expect(shown.at(-1)).toEqual(["lease", "deposit"]);
  });

  test("clearing before anything loads forgets the device's and hides the server's from before", async () => {
    const read = deferred<undefined>();
    const device = deviceWith(
      serializeRecents(kept([{ query: "deposit", usedAt: 10 }])),
      read.promise,
    );
    const server = deferred<RecentSearch[]>();
    const { recents, shown } = opened({
      device,
      server: server.promise,
      now: 100,
    });

    const clearing = recents.clear();
    read.resolve(undefined);
    await clearing;
    expect(device.writes.map((written) => readStoredRecents(written))).toEqual([
      kept([], 100),
    ]);
    expect(shown.at(-1)).toEqual([]);

    server.resolve([
      { query: "before", usedAt: 90 },
      { query: "since", usedAt: 110 },
    ]);
    await recents.ready;
    expect(shown.at(-1)).toEqual(["since"]);
  });
});
