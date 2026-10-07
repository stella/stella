import { useState, useSyncExternalStore } from "react";

import { deviceStorage } from "@/lib/account/browser-storage";

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
            deviceStorage("local").getItem(SIDEBAR_STORAGE_KEY),
          ) ?? defaultOpen)
        : defaultOpen,
    () => defaultOpen,
  );
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? storedOpen;

  const persistOpen = (nextOpen: boolean) => {
    deviceStorage("local").setItem(
      SIDEBAR_STORAGE_KEY,
      nextOpen ? "expanded" : "collapsed",
    );
  };

  return { open, persistOpen, setOpen: setOpenOverride };
};
