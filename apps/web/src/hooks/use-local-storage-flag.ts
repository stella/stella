import { useCallback, useSyncExternalStore } from "react";

const getServerSnapshot = () => false;

/** Reads a persisted flag without changing the client's hydration snapshot. */
export const useLocalStorageFlag = (key: string): boolean => {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === key) {
          onStoreChange();
        }
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
    [key],
  );
  const getSnapshot = useCallback(
    () => localStorage.getItem(key) === "1",
    [key],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
};
