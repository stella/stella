import { useState } from "react";

import {
  readPersistedSidebarOpen,
  writePersistedSidebarOpen,
} from "@/components/sidebar/sidebar-state";

export const usePersistedSidebarOpen = ({
  defaultOpen,
  hydrateFromStorage,
}: {
  defaultOpen: boolean;
  hydrateFromStorage: boolean;
}) => {
  // The cookie is the same on the server and in the hydrating client, so the
  // first render already matches what the user left.
  const [open, setOpen] = useState(() =>
    hydrateFromStorage
      ? (readPersistedSidebarOpen() ?? defaultOpen)
      : defaultOpen,
  );

  return { open, persistOpen: writePersistedSidebarOpen, setOpen };
};
