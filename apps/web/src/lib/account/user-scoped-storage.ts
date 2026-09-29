import type { QueryClient } from "@tanstack/react-query";
import { hashKey } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import type { StateStorage } from "zustand/middleware";

import { rootKeys } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { signedInUserId } from "@/lib/session-cache-guard";

/**
 * What the browser keeps for one signed-in user (recent searches, drafts,
 * tracked exports, tool grants, open tabs) belongs to that user alone. Each
 * such entry is keyed by its owner, and every session read prunes the
 * browser's entries to the owner it names: a signed-in user keeps only their
 * own, and a visitor without a session keeps only the visitor's.
 */

/** Whose entries the browser holds: a signed-in user, or a visitor. */
export type StorageOwner =
  | { kind: "user"; userId: string }
  | { kind: "visitor" };

const VISITOR: StorageOwner = { kind: "visitor" };
const VISITOR_SUFFIX = ":visitor";
const USER_SEGMENT = ":u:";

/** Who this tab last belonged to, kept across its reloads. */
const TAB_OWNER_KEY = "stella.storage-owner";

type StorageArea = "local" | "session";

/** How to tell whose entry a key is. */
type OwnerReading =
  /** Keyed by this module: `<base>:u:<userId>` or `<base>:visitor`. */
  | "scoped"
  /** Keyed elsewhere, by organization and user: `<prefix><orgId>:<userId>`. */
  | "lastSegment"
  /** Keyed elsewhere, by user: `<prefix><userId>`. */
  | "afterPrefix"
  /**
   * Not keyed by owner: held for whoever the tab is signed in as, carried
   * from a visitor into the account they sign in to, and dropped when a
   * signed-in user leaves.
   */
  | "carried";

type UserStorageFamily = {
  area: StorageArea;
  prefix: string;
  owner: OwnerReading;
  /**
   * An entry written before entries were keyed by owner (its key is the bare
   * prefix) is dropped, unless it holds a protective choice: then the first
   * user identified in this browser takes over the part `adopt` keeps, and
   * until then the entry stays.
   */
  legacy?: { adopt: (raw: string) => string | null } | undefined;
};

/**
 * The fields of a persisted store's entry worth taking over, or `null` when
 * the entry holds none. Typed `unknown` on purpose: it reads stored JSON.
 */
const keepPersistedFields =
  (fields: readonly string[]) =>
  (raw: string): string | null => {
    const parsed = Result.try((): unknown => JSON.parse(raw)).unwrapOr(null);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("state" in parsed) ||
      typeof parsed.state !== "object" ||
      parsed.state === null
    ) {
      return null;
    }
    const { state } = parsed;
    const kept = Object.fromEntries(
      Object.entries(state).filter(([field]) => fields.includes(field)),
    );
    if (Object.keys(kept).length === 0) {
      return null;
    }
    const version = "version" in parsed ? parsed.version : undefined;
    return JSON.stringify({ state: kept, version });
  };

/** Every kind of entry that belongs to one user. */
const USER_STORAGE_FAMILIES: readonly UserStorageFamily[] = [
  { area: "local", prefix: "law_search_history", owner: "scoped" },
  {
    area: "local",
    prefix: "stella.organize-suggestions.user-instructions.",
    owner: "scoped",
  },
  {
    area: "local",
    prefix: "stella.chat.anonymized",
    owner: "scoped",
    // The chosen default only; the per-chat modes name one user's chats.
    legacy: { adopt: keepPersistedFields(["defaultSendMode"]) },
  },
  { area: "local", prefix: "stella.report-exports.active", owner: "scoped" },
  { area: "local", prefix: "stella.chat.alwaysApprovedTools", owner: "scoped" },
  { area: "local", prefix: "stella:inspector-state:v1:", owner: "lastSegment" },
  {
    area: "local",
    prefix: "stella:inspector-minimized:v1:",
    owner: "lastSegment",
  },
  {
    area: "local",
    prefix: "stella-search-recent-searches:",
    owner: "lastSegment",
  },
  {
    area: "local",
    prefix: "stella-search-recent-files:",
    owner: "lastSegment",
  },
  { area: "local", prefix: "sidebar_pinned_", owner: "afterPrefix" },
  { area: "session", prefix: "stella.provision-question:", owner: "carried" },
  {
    area: "session",
    prefix: "stella.chat.conversationApprovedTools:",
    owner: "carried",
  },
  {
    area: "session",
    prefix: "stella.chat.browserApprovalMode",
    owner: "carried",
  },
];

let currentOwner: StorageOwner = VISITOR;
let ownerListeners: readonly (() => void)[] = [];
// Set while a store goes back to its first state for a new owner, so that
// state is not written over the new owner's entry.
let writesSuspended = false;

/** Whose entries the browser holds now; a visitor until a session is read. */
export const storageOwner = (): StorageOwner => currentOwner;

/** The key an entry of `base` has for `owner`. */
export const userStorageKey = (
  base: string,
  owner: StorageOwner = currentOwner,
): string =>
  owner.kind === "user"
    ? `${base}${USER_SEGMENT}${owner.userId}`
    : `${base}${VISITOR_SUFFIX}`;

/** Runs `listener` whenever the owner changes; returns the unsubscribe. */
export const onStorageOwnerChange = (listener: () => void) => {
  ownerListeners = [...ownerListeners, listener];
  return () => {
    ownerListeners = ownerListeners.filter((other) => other !== listener);
  };
};

/**
 * A zustand persist storage whose entry follows the owner. Pass it the area
 * inside `createJSONStorage`'s getter, which already copes with a page that
 * has none (the server, blocked site data). The store reads again when the
 * owner changes (see `followStorageOwner`).
 */
export const userScopedStateStorage = (area: Storage): StateStorage => ({
  getItem: (name) => area.getItem(userStorageKey(name)),
  setItem: (name, value) => {
    if (!writesSuspended) {
      area.setItem(userStorageKey(name), value);
    }
  },
  removeItem: (name) => {
    if (!writesSuspended) {
      area.removeItem(userStorageKey(name));
    }
  },
});

type PersistedStore<TState> = {
  getInitialState: () => TState;
  setState: (state: TState, replace: true) => void;
  /** Absent where the page has no storage (the server, blocked site data). */
  persist?: { rehydrate: () => Promise<void> | void } | undefined;
};

/**
 * Keeps a persisted store on its owner's entry: when the owner changes it
 * goes back to its first state, without writing that anywhere, then takes
 * the new owner's stored one.
 */
export const followStorageOwner = <TState>(store: PersistedStore<TState>) =>
  onStorageOwnerChange(() => {
    writesSuspended = true;
    store.setState(store.getInitialState(), true);
    writesSuspended = false;
    const { persist } = store;
    if (persist !== undefined) {
      detached(
        Promise.resolve(persist.rehydrate()),
        "user-scoped-storage.rehydrate",
      );
    }
  });

type Areas = Record<StorageArea, Storage | null>;

/** Whose a key is, as `family` reads it: a user id, the visitor, or unknown. */
const ownerOfKey = (
  family: UserStorageFamily,
  key: string,
): StorageOwner | "unknown" => {
  switch (family.owner) {
    case "scoped": {
      if (key.endsWith(VISITOR_SUFFIX)) {
        return VISITOR;
      }
      const at = key.lastIndexOf(USER_SEGMENT);
      return at === -1
        ? "unknown"
        : { kind: "user", userId: key.slice(at + USER_SEGMENT.length) };
    }
    case "lastSegment": {
      const userId = key.slice(key.lastIndexOf(":") + 1);
      return userId === "" ? "unknown" : { kind: "user", userId };
    }
    case "afterPrefix": {
      const userId = key.slice(family.prefix.length);
      return userId === "" ? "unknown" : { kind: "user", userId };
    }
    case "carried":
      return "unknown";
    default: {
      family.owner satisfies never;
      return panic(`Unhandled owner reading: ${String(family.owner)}`);
    }
  }
};

const sameOwner = (a: StorageOwner, b: StorageOwner) =>
  a.kind === "user"
    ? b.kind === "user" && a.userId === b.userId
    : b.kind === a.kind;

/** Whether an entry stays once `next` owns the browser, coming from `previous`. */
const keeps = (
  family: UserStorageFamily,
  key: string,
  previous: StorageOwner,
  next: StorageOwner,
): boolean => {
  if (family.owner === "carried") {
    // A visitor's draft goes on into their account; a signed-in user's never
    // outlives them.
    return previous.kind === "visitor" || sameOwner(previous, next);
  }
  if (
    key === family.prefix &&
    family.legacy !== undefined &&
    next.kind === "visitor"
  ) {
    // Kept for the first user to sign in, who takes it over.
    return true;
  }
  const owner = ownerOfKey(family, key);
  return owner !== "unknown" && sameOwner(owner, next);
};

const keysOf = (storage: Storage): string[] =>
  Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter((key): key is string => key !== null);

/**
 * Removes every entry that is not `next`'s. Entries written before they were
 * keyed by owner belong to no one known and go too, but for the protective
 * part of one, which the first user takes over.
 */
export const pruneUserStorage = (
  areas: Areas,
  previous: StorageOwner,
  next: StorageOwner,
): void => {
  for (const family of USER_STORAGE_FAMILIES) {
    const storage = areas[family.area];
    if (storage === null) {
      continue;
    }
    const legacyValue = storage.getItem(family.prefix);
    const adopted =
      family.legacy !== undefined && legacyValue !== null
        ? family.legacy.adopt(legacyValue)
        : null;
    if (
      adopted !== null &&
      next.kind === "user" &&
      storage.getItem(userStorageKey(family.prefix, next)) === null
    ) {
      storage.setItem(userStorageKey(family.prefix, next), adopted);
    }
    for (const key of keysOf(storage)) {
      if (
        key.startsWith(family.prefix) &&
        !keeps(family, key, previous, next)
      ) {
        storage.removeItem(key);
      }
    }
  }
};

const serializeOwner = (owner: StorageOwner) =>
  owner.kind === "user" ? `u:${owner.userId}` : "visitor";

/** Who this tab last belonged to, from an earlier document of it. */
const readTabOwner = (areas: Areas): StorageOwner | null => {
  const stored = areas.session?.getItem(TAB_OWNER_KEY) ?? null;
  if (stored === null) {
    return null;
  }
  return stored.startsWith("u:")
    ? { kind: "user", userId: stored.slice("u:".length) }
    : VISITOR;
};

const setOwner = (areas: Areas, next: StorageOwner) => {
  Result.try(() => {
    areas.session?.setItem(TAB_OWNER_KEY, serializeOwner(next));
  }).unwrapOr(undefined);
  if (sameOwner(currentOwner, next)) {
    return;
  }
  currentOwner = next;
  for (const listener of ownerListeners) {
    listener();
  }
};

/** The browser's storage areas, where the page can reach them. */
const browserStorageAreas = (): Areas => ({
  local: Result.try(() => window.localStorage).unwrapOr(null),
  session: Result.try(() => window.sessionStorage).unwrapOr(null),
});

/** Moves the browser's entries to `next`, whoever held them before. */
const handOver = (areas: Areas, next: StorageOwner) => {
  // A tab reloaded since its last owner still remembers them: the tab's own
  // entries follow that owner, not the visitor every document starts as.
  const previous = readTabOwner(areas) ?? currentOwner;
  // A storage area the page cannot use (blocked site data) holds nothing
  // to prune; the rest still is.
  Result.try(() => {
    pruneUserStorage(areas, previous, next);
  }).unwrapOr(undefined);
  setOwner(areas, next);
};

/** Signing out: nothing of the user stays, and the visitor owns the browser. */
export const releaseUserStorage = (areas: Areas = browserStorageAreas()) => {
  handOver(areas, VISITOR);
};

const SESSION_QUERY_HASH = hashKey(rootKeys.session);

/**
 * Prunes the browser's per-user entries to the owner every session read
 * names. Pruning on each read, not only on a change seen in this page, covers
 * a different user signing in after a reload.
 */
export const installUserScopedStorage = (
  queryClient: QueryClient,
  areas: () => Areas = browserStorageAreas,
) =>
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") {
      return;
    }
    if (event.query.queryHash !== SESSION_QUERY_HASH) {
      return;
    }
    const session: unknown = event.query.state.data;
    const userId = signedInUserId(session);
    handOver(
      areas(),
      userId === undefined ? VISITOR : { kind: "user", userId },
    );
  });
