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
 * such entry is keyed by its owner and read only under the current owner's
 * key. Every session read prunes the browser's entries for the owner it
 * names: the user's own history, drafts and choices wait under their key for
 * them to come back, and everything else of anyone but that owner goes.
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
  const { owner } = family;
  switch (owner) {
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
      owner satisfies never;
      return panic(`Unhandled owner reading: ${String(owner)}`);
    }
  }
};

const sameOwner = (a: StorageOwner, b: StorageOwner) =>
  a.kind === "user"
    ? b.kind === "user" && a.userId === b.userId
    : b.kind === a.kind;

/** How a browser changes hands. */
type Transition = {
  previous: StorageOwner;
  next: StorageOwner;
  /**
   * The previous user's account is gone: what is kept for an owner who comes
   * back goes too.
   */
  forgetPrevious: boolean;
};

/**
 * An entry from before entries were keyed by owner: the base its per-user
 * key is built on, and the user it was written for (`null`: anyone, so the
 * first user to sign in takes it over).
 */
const readLegacyKey = (
  family: UserStorageFamily,
  key: string,
): { base: string; userId: string | null } | null => {
  if (family.legacy === undefined || ownerOfKey(family, key) !== "unknown") {
    return null;
  }
  switch (family.legacy.keys) {
    case "bare":
      return key === family.prefix ? { base: key, userId: null } : null;
    case "base":
      return { base: key, userId: null };
    case "user-suffix": {
      const tail = key.slice(family.prefix.length);
      const at = tail.lastIndexOf(":");
      const userId = tail.slice(at + 1);
      return userId === ""
        ? null
        : { base: family.prefix + tail.slice(0, at + 1), userId };
    }
    default: {
      family.legacy.keys satisfies never;
      return panic(`Unhandled legacy keys: ${String(family.legacy.keys)}`);
    }
  }
};

/** Whether an owner-keyed entry stays through `transition`. */
const keeps = (
  family: UserStorageFamily,
  key: string,
  { previous, next, forgetPrevious }: Transition,
): boolean => {
  if (family.owner === "carried") {
    // A visitor's draft goes on into their account; a signed-in user's never
    // outlives them.
    return previous.kind === "visitor" || sameOwner(previous, next);
  }
  const owner = ownerOfKey(family, key);
  if (owner === "unknown") {
    return false;
  }
  if (
    family.retention === "kept-for-owner" &&
    owner.kind === "user" &&
    !(forgetPrevious && sameOwner(owner, previous))
  ) {
    // Waits under its owner's key for them; every read names the current
    // owner's key, so no one else reads it.
    return true;
  }
  return sameOwner(owner, next);
};

/**
 * Takes an entry from before entries were keyed by owner into the signed-in
 * user's own entry, when it can be theirs. Until then it stays: the user's
 * data is moved, never dropped.
 */
const adoptLegacy = (
  storage: Storage,
  entry: {
    family: UserStorageFamily;
    key: string;
    legacy: { base: string; userId: string | null };
  },
  { previous, next, forgetPrevious }: Transition,
) => {
  const { family, key, legacy } = entry;
  if (
    forgetPrevious &&
    legacy.userId !== null &&
    previous.kind === "user" &&
    previous.userId === legacy.userId
  ) {
    storage.removeItem(key);
    return;
  }
  if (
    family.legacy === undefined ||
    next.kind !== "user" ||
    (legacy.userId !== null && legacy.userId !== next.userId)
  ) {
    return;
  }
  const raw = storage.getItem(key);
  const target = userStorageKey(legacy.base, next);
  const adopted =
    raw === null ? null : family.legacy.adopt(raw, storage.getItem(target));
  if (adopted !== null) {
    storage.setItem(target, adopted);
  }
  storage.removeItem(key);
};

const keysOf = (storage: Storage): string[] =>
  Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter((key): key is string => key !== null);

/**
 * Leaves the browser's entries as `next` may find them: what is kept for its
 * owner stays under that owner's key, everything else that is not `next`'s
 * goes. Entries written before they were keyed by owner move into the first
 * user they can belong to; an unkeyed entry no family takes over goes.
 */
export const pruneUserStorage = (
  areas: Areas,
  previous: StorageOwner,
  next: StorageOwner,
  { forgetPrevious = false }: { forgetPrevious?: boolean } = {},
): void => {
  const transition = { previous, next, forgetPrevious };
  for (const family of USER_STORAGE_FAMILIES) {
    const storage = areas[family.area];
    if (storage === null) {
      continue;
    }
    for (const key of keysOf(storage)) {
      if (!key.startsWith(family.prefix)) {
        continue;
      }
      const legacy = readLegacyKey(family, key);
      if (legacy !== null) {
        adoptLegacy(storage, { family, key, legacy }, transition);
      } else if (!keeps(family, key, transition)) {
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
const handOver = (
  areas: Areas,
  next: StorageOwner,
  options: { forgetPrevious?: boolean } = {},
) => {
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
        options,
      );
    }).unwrapOr(undefined);
  }
  setOwner(areas, next);
};

/**
 * Signing out: the visitor owns the browser. Only what is kept for its owner
 * (their history, drafts and choices) stays, under the user's own key, for
 * when they sign in again; everything else of the user goes.
 */
export const releaseUserStorage = (areas: Areas = browserStorageAreas()) => {
  handOver(areas, VISITOR);
};

/** The account is deleted: nothing of the user stays in this browser. */
export const forgetUserStorage = (areas: Areas = browserStorageAreas()) => {
  handOver(areas, VISITOR, { forgetPrevious: true });
};

/** The authentication boundary supplies the account identified by its session. */
export const assignUserStorage = (
  userId: string | undefined,
  areas: Areas = browserStorageAreas(),
) => handOver(areas, userId === undefined ? VISITOR : { kind: "user", userId });
