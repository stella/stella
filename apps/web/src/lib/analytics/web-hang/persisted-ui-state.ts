import { Result } from "better-result";

import {
  DEVICE_STORAGE_FAMILIES,
  USER_STORAGE_FAMILIES,
} from "@/lib/account/storage-families";

export type PersistedDeviceUiStateKey = `${Extract<
  (typeof DEVICE_STORAGE_FAMILIES)[number],
  { restoration: "layout" }
>["prefix"]}${string}`;

/** Derived from storage ownership: adding persistence requires a reset decision. */
export const PERSISTED_UI_STATE_PREFIXES = [
  ...USER_STORAGE_FAMILIES,
  ...DEVICE_STORAGE_FAMILIES,
]
  .filter(
    ({ area, restoration }) => area === "local" && restoration === "layout",
  )
  .map(({ prefix }) => prefix);

// Older builds left these exact, unscoped entries behind.
const LEGACY_UI_STATE_KEYS = [
  "stella:inspector-state",
  "stella:inspector-width",
  "stella:inspector-minimized",
];

export const PERSISTED_UI_STATE_NAMES = [
  ...PERSISTED_UI_STATE_PREFIXES,
  ...LEGACY_UI_STATE_KEYS,
];

/** A family name, never an actual storage key that could contain an account id. */
const uiStateName = (key: string): string | undefined =>
  LEGACY_UI_STATE_KEYS.includes(key)
    ? key
    : PERSISTED_UI_STATE_PREFIXES.find((prefix) => key.startsWith(prefix));

const storedKeys = (storage: Storage): string[] =>
  Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter((key): key is string => key !== null);

/** No values, owner suffixes, document ids, or content hashes leave this boundary. */
export const persistedUiStateFingerprint = (storage: Storage | null) => {
  if (storage === null) {
    return [];
  }
  return Result.try(() => {
    const sizes = new Map<string, number>();
    for (const key of storedKeys(storage)) {
      const name = uiStateName(key);
      if (name === undefined) {
        continue;
      }
      const value = storage.getItem(key);
      if (value !== null) {
        const bytes = new TextEncoder().encode(value).byteLength;
        sizes.set(name, (sizes.get(name) ?? 0) + bytes);
      }
    }
    return Array.from(sizes, ([key, bytes]) => ({ key, bytes })).toSorted(
      (a, b) => {
        if (a.key === b.key) {
          return 0;
        }
        return a.key < b.key ? -1 : 1;
      },
    );
  }).unwrapOr([]);
};

/** Run before application imports: stores can restore during module evaluation. */
export const resetPersistedUiState = (storage: Storage | null): void => {
  if (storage === null) {
    return;
  }
  const keys = Result.try(() => storedKeys(storage)).unwrapOr([]);
  for (const key of keys) {
    if (uiStateName(key) !== undefined) {
      // One blocked key must not stop recovery of the remaining layout.
      Result.try(() => storage.removeItem(key)).unwrapOr(undefined);
    }
  }
};

export const isPersistedUiStateFingerprintKey = (key: string): boolean =>
  PERSISTED_UI_STATE_NAMES.includes(key);
