import { panic, Result, TaggedError } from "better-result";

import {
  DEVICE_STORAGE_FAMILIES,
  LEGACY_STORAGE_FAMILIES,
  USER_STORAGE_FAMILIES,
} from "@/lib/account/storage-families";
import type { StorageArea } from "@/lib/account/storage-families";

/** Real browser storage for hydration, storage events, and strict persistence. */
export const browserStorage = (area: StorageArea): Storage | null =>
  Result.try(() => {
    const browser = typeof window === "undefined" ? globalThis : window;
    return area === "local" ? browser.localStorage : browser.sessionStorage;
  }).unwrapOr(null) ?? null;

type StorageRegistrationOptions = {
  area: StorageArea;
  key: string;
  ownership: "device" | "any";
};

const assertLegacyRegistered = (key: string) => {
  if (
    !LEGACY_STORAGE_FAMILIES.some((family) => key.startsWith(family.prefix))
  ) {
    panic(`Unregistered legacy local storage family: ${key}`);
  }
};

/** Superseded entries are deliberately read/delete-only outside test fixtures. */
export const legacyBrowserStorage = {
  getItem: (key: string) => {
    assertLegacyRegistered(key);
    return Result.try(() => browserStorage("local")?.getItem(key) ?? null);
  },
  removeItem: (key: string) => {
    assertLegacyRegistered(key);
    return Result.try(() => browserStorage("local")?.removeItem(key));
  },
};

/** Internal seam used only by the legacy-storage test fixture module. */
export const seedLegacyBrowserStorageForTest = (key: string, value: string) => {
  assertLegacyRegistered(key);
  const storage = browserStorage("local");
  if (storage === null) {
    panic("Legacy storage fixture requires local storage");
  }
  storage.setItem(key, value);
};

const assertRegistered = ({
  area,
  key,
  ownership,
}: StorageRegistrationOptions) => {
  const families =
    ownership === "device"
      ? DEVICE_STORAGE_FAMILIES
      : [...DEVICE_STORAGE_FAMILIES, ...USER_STORAGE_FAMILIES];
  if (
    !families.some(
      (family) => family.area === area && key.startsWith(family.prefix),
    )
  ) {
    panic(`Unregistered ${area} storage family: ${key}`);
  }
};

/** UI persistence is best-effort when site data is blocked or full. */
const stateStorage = (
  area: StorageArea,
  ownership: "device" | "any",
): Storage => ({
  get length() {
    return Result.try(() => browserStorage(area)?.length ?? 0).unwrapOr(0);
  },
  key: (index) =>
    Result.try(() => browserStorage(area)?.key(index) ?? null).unwrapOr(null),
  clear: () => {
    panic("Clear storage through its account owner");
  },
  getItem: (key) => {
    assertRegistered({ area, key, ownership });
    return (
      Result.try(() => browserStorage(area)?.getItem(key) ?? null).unwrapOr(
        null,
      ) ?? null
    );
  },
  setItem: (key, value) => {
    assertRegistered({ area, key, ownership });
    Result.try(() => browserStorage(area)?.setItem(key, value)).unwrapOr(
      undefined,
    );
  },
  removeItem: (key) => {
    assertRegistered({ area, key, ownership });
    Result.try(() => browserStorage(area)?.removeItem(key)).unwrapOr(undefined);
  },
});

const localState = stateStorage("local", "any");
const sessionState = stateStorage("session", "any");
const localDevice = stateStorage("local", "device");
const sessionDevice = stateStorage("session", "device");

export const browserStateStorage = (area: StorageArea): Storage =>
  area === "local" ? localState : sessionState;
export const deviceStorage = (area: StorageArea): Storage =>
  area === "local" ? localDevice : sessionDevice;

class BrowserStorageUnavailableError extends TaggedError(
  "BrowserStorageUnavailableError",
)<{ message: string; area: StorageArea }> {}

/** Registered persistence that propagates blocked-storage and quota failures. */
export const requireBrowserStorage = (area: StorageArea) => {
  const storage = browserStorage(area);
  if (storage === null) {
    return Result.err(
      new BrowserStorageUnavailableError({
        message: "Browser storage is unavailable",
        area,
      }),
    );
  }
  return Result.ok({
    get length() {
      return storage.length;
    },
    key: (index) => storage.key(index),
    clear: () => {
      panic("Clear storage through its account owner");
    },
    getItem: (key) => {
      assertRegistered({ area, key, ownership: "any" });
      return storage.getItem(key);
    },
    setItem: (key, value) => {
      assertRegistered({ area, key, ownership: "any" });
      storage.setItem(key, value);
    },
    removeItem: (key) => {
      assertRegistered({ area, key, ownership: "any" });
      storage.removeItem(key);
    },
  } satisfies Storage);
};
