import { useSyncExternalStore } from "react";

import {
  getAnonymizationCacheSnapshot,
  getAnonymizedFieldIds,
  subscribeAnonymizationCache,
} from "@/lib/pdf/anonymization-cache";

/** Subscribes to anonymization cache keys (which PDF field ids have overlay data). */
export const useAnonymizedFieldIds = (): string[] => {
  const snapshot = useSyncExternalStore(
    subscribeAnonymizationCache,
    getAnonymizationCacheSnapshot,
    () => "0:",
  );
  void snapshot;
  return getAnonymizedFieldIds();
};
