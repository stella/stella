import { useState, useSyncExternalStore } from "react";

const SIDEBAR_STORAGE_KEY = "sidebar_state";

export const parsePersistedSidebarOpen = (
  storedState: string | null,
): boolean | null => {
  if (storedState === null) {
    return null;
  }
  return storedState === "expanded";
};

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

export const usePersistedSidebarOpen = ({
  defaultOpen,
  hydrateFromStorage,
}: {
  defaultOpen: boolean;
  hydrateFromStorage: boolean;
}) => {
  const storedOpen = useSyncExternalStore(
    noopSubscribe,
    () =>
      hydrateFromStorage
        ? (parsePersistedSidebarOpen(
            localStorage.getItem(SIDEBAR_STORAGE_KEY),
          ) ?? defaultOpen)
        : defaultOpen,
    () => defaultOpen,
  );
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? storedOpen;

  const persistOpen = (nextOpen: boolean) => {
    localStorage.setItem(
      SIDEBAR_STORAGE_KEY,
      nextOpen ? "expanded" : "collapsed",
    );
  };

  return { open, persistOpen, setOpen: setOpenOverride };
};
