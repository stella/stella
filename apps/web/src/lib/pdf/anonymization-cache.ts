import type { StoreApi } from "zustand";

import type { FileAnonymization } from "./anonymization-types";

type AnonymizationStore = StoreApi<
  AnonymizationStoreSlice & { fieldId: string }
>;

class AnonymizationExternalStore {
  private readonly cache = new Map<string, FileAnonymization>();
  private readonly listeners = new Set<() => void>();
  private readonly registered = new Map<string, AnonymizationStore>();
  private version = 0;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(fieldId: string) {
    return this.cache.get(fieldId);
  }

  keys() {
    return [...this.cache.keys()];
  }

  snapshot() {
    return `${this.version}:${this.keys().toSorted().join("\x1e")}`;
  }

  set(fieldId: string, data: FileAnonymization) {
    this.cache.set(fieldId, data);
    this.notify();
  }

  delete(fieldId: string) {
    this.cache.delete(fieldId);
    this.notify();
  }

  register(fieldId: string, store: AnonymizationStore) {
    this.registered.set(fieldId, store);
    return () => {
      if (this.registered.get(fieldId) === store) {
        this.registered.delete(fieldId);
      }
    };
  }

  sync(fieldId: string, data: FileAnonymization | null) {
    this.registered.get(fieldId)?.setState({ fileAnonymization: data });
  }

  private notify() {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const externalStore = new AnonymizationExternalStore();

export const subscribeAnonymizationCache = (listener: () => void) =>
  externalStore.subscribe(listener);

export const getCachedAnonymization = (
  fieldId: string,
): FileAnonymization | undefined => externalStore.get(fieldId);

export const getAnonymizedFieldIds = (): string[] => externalStore.keys();

/** For useSyncExternalStore: version plus key set so subscribers see key changes. */
export const getAnonymizationCacheSnapshot = (): string =>
  externalStore.snapshot();

export const setCachedAnonymization = (
  fieldId: string,
  data: FileAnonymization,
) => {
  externalStore.set(fieldId, data);
};

export const deleteCachedAnonymization = (fieldId: string) => {
  externalStore.delete(fieldId);
};

type AnonymizationStoreSlice = {
  fileAnonymization: FileAnonymization | null;
};

export const registerAnonymizationStore = (
  fieldId: string,
  store: StoreApi<AnonymizationStoreSlice & { fieldId: string }>,
) => externalStore.register(fieldId, store);

const syncToRegisteredStore = (
  fieldId: string,
  data: FileAnonymization | null,
) => {
  externalStore.sync(fieldId, data);
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
