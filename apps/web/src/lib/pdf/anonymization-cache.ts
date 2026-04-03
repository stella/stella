import type { StoreApi } from "zustand";

import type { FileAnonymization } from "./anonymization-types";

const cache = new Map<string, FileAnonymization>();
const listeners = new Set<() => void>();

let cacheVersion = 0;

const getAnonymizationCacheVersion = () => cacheVersion;

export const subscribeAnonymizationCache = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notify = () => {
  cacheVersion += 1;
  for (const l of listeners) {
    l();
  }
};

export const getCachedAnonymization = (
  fieldId: string,
): FileAnonymization | undefined => cache.get(fieldId);

export const getAnonymizedFieldIds = (): string[] => [...cache.keys()];

/** For useSyncExternalStore: version plus key set so subscribers see key changes. */
export const getAnonymizationCacheSnapshot = (): string =>
  `${getAnonymizationCacheVersion()}:${[...cache.keys()].toSorted().join("\x1e")}`;

export const setCachedAnonymization = (
  fieldId: string,
  data: FileAnonymization,
) => {
  cache.set(fieldId, data);
  notify();
};

export const deleteCachedAnonymization = (fieldId: string) => {
  cache.delete(fieldId);
  notify();
};

type AnonymizationStoreSlice = {
  fileAnonymization: FileAnonymization | null;
};

const registered = new Map<
  string,
  StoreApi<AnonymizationStoreSlice & { fieldId: string }>
>();

export const registerAnonymizationStore = (
  fieldId: string,
  store: StoreApi<AnonymizationStoreSlice & { fieldId: string }>,
) => {
  registered.set(fieldId, store);
  return () => {
    if (registered.get(fieldId) === store) {
      registered.delete(fieldId);
    }
  };
};

const syncToRegisteredStore = (
  fieldId: string,
  data: FileAnonymization | null,
) => {
  registered.get(fieldId)?.setState({ fileAnonymization: data });
};

/** Pipeline / external commit: cache + any mounted PDF store for this field. */
export const commitAnonymizationForField = (
  fieldId: string,
  data: FileAnonymization,
) => {
  setCachedAnonymization(fieldId, data);
  syncToRegisteredStore(fieldId, data);
};

/** Clear cache and in-memory store for this field (e.g. tab close, user clear). */
export const clearAnonymizationForField = (fieldId: string) => {
  deleteCachedAnonymization(fieldId);
  syncToRegisteredStore(fieldId, null);
};

let nextEntityOverlayId = 1;
export const allocateEntityOverlayId = (): number => nextEntityOverlayId++;
