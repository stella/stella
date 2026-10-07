import { panic, Result } from "better-result";
import type { StateStorage } from "zustand/middleware";

import { browserStorage } from "@/lib/account/browser-storage";
import { USER_STORAGE_FAMILIES } from "@/lib/account/storage-families";
import type { StorageArea } from "@/lib/account/storage-families";
import {
  ownerStorageKey,
  type StorageOwner,
  USER_SEGMENT,
  VISITOR_SUFFIX,
} from "@/lib/account/storage-key";
import { detached } from "@/lib/detached";

/**
 * What the browser keeps for one signed-in user (recent searches, drafts,
 * tracked exports, tool grants, open tabs) belongs to that user alone. Each
 * such entry is keyed by its owner, and every session read prunes the
 * browser's entries to the owner it names: a signed-in user keeps only their
 * own, and a visitor without a session keeps only the visitor's.
 */

export type { StorageOwner };

const VISITOR: StorageOwner = { kind: "visitor" };

/** Who this tab last belonged to, kept across its reloads. */
const TAB_OWNER_KEY = "stella.storage-owner";

let currentOwner: StorageOwner = VISITOR;
let ownerListeners: readonly (() => void)[] = [];
// Set while a store goes back to its first state for a new owner, so that
// state is not written over the new owner's entry.
let writesSuspended = false;

/** Whose entries the browser holds now; a visitor until a session is read. */
export const storageOwner = (): StorageOwner => currentOwner;

/** Pending work belongs to the exact account transition that started it. */
export const isCurrentStorageOwner = (owner: StorageOwner): boolean =>
  owner === currentOwner;

/** The key an entry of `base` has for `owner`. */
export const userStorageKey = (
  base: string,
  owner: StorageOwner = currentOwner,
): string => {
  if (
    !USER_STORAGE_FAMILIES.some(
      (family) => family.owner === "scoped" && base.startsWith(family.prefix),
    )
  ) {
    panic(`Unregistered user storage family: ${base}`);
  }
  return ownerStorageKey(base, owner);
};

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
export const userScopedStateStorage = (area: Storage) =>
  ({
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
  }) satisfies StateStorage;

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
type UserStorageFamily = (typeof USER_STORAGE_FAMILIES)[number];

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
  currentOwner =
    next.kind === "user"
      ? { kind: "user", userId: next.userId }
      : { kind: "visitor" };
  for (const listener of ownerListeners) {
    listener();
  }
};

/** The browser's storage areas, where the page can reach them. */
const browserStorageAreas = (): Areas => ({
  local: browserStorage("local"),
  session: browserStorage("session"),
});

export const hasCurrentTabStorageOwner = (
  areas: Areas = browserStorageAreas(),
) => {
  const tabOwner = Result.try(() => readTabOwner(areas)).unwrapOr(null);
  return (
    currentOwner.kind === "user" &&
    tabOwner !== null &&
    sameOwner(currentOwner, tabOwner)
  );
};

/** Moves the browser's entries to `next`, whoever held them before. */
const handOver = (areas: Areas, next: StorageOwner) => {
  // A tab reloaded since its last owner still remembers them: the tab's own
  // entries follow that owner, not the visitor every document starts as.
  const previous =
    Result.try(() => readTabOwner(areas)).unwrapOr(null) ?? currentOwner;
  // A storage area the page cannot use (blocked site data) holds nothing
  // to prune; the rest still is.
  for (const [area, storage] of Object.entries(areas)) {
    Result.try(() => {
      pruneUserStorage(
        { local: null, session: null, [area]: storage },
        previous,
        next,
      );
    }).unwrapOr(undefined);
  }
  setOwner(areas, next);
};

/** Signing out: nothing of the user stays, and the visitor owns the browser. */
export const releaseUserStorage = (areas: Areas = browserStorageAreas()) => {
  handOver(areas, VISITOR);
};

/** The authentication boundary supplies the account identified by its session. */
export const assignUserStorage = (
  userId: string | undefined,
  areas: Areas = browserStorageAreas(),
) => handOver(areas, userId === undefined ? VISITOR : { kind: "user", userId });
