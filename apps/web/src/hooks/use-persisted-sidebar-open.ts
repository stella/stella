import { useState } from "react";

import { useMountEffect } from "@/hooks/use-effect";

const SIDEBAR_STORAGE_KEY = "sidebar_state";

export const usePersistedSidebarOpen = ({
  defaultOpen,
  hydrateFromStorage,
}: {
  defaultOpen: boolean;
  hydrateFromStorage: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);

  useMountEffect(() => {
    if (!hydrateFromStorage) {
      return;
    }
    const storedState = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (storedState !== null) {
      setOpen(storedState === "expanded");
    }
  });

  const persistOpen = (nextOpen: boolean) => {
    localStorage.setItem(
      SIDEBAR_STORAGE_KEY,
      nextOpen ? "expanded" : "collapsed",
    );
  };

  return { open, persistOpen, setOpen };
};
