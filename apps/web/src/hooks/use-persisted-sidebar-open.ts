import { useState } from "react";

import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

type PersistedSidebarOpenOptions = {
  defaultOpen: boolean;
  usePreference: boolean;
};

export const usePersistedSidebarOpen = ({
  defaultOpen,
  usePreference,
}: PersistedSidebarOpenOptions) => {
  const { prefs, setPrefs } = usePresentationPrefs();
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = usePreference
    ? prefs.sidebarOpen
    : (openOverride ?? defaultOpen);
  const persistOpen = (nextOpen: boolean) =>
    setPrefs(() => ({ sidebarOpen: nextOpen }));
  return { open, persistOpen, setOpen: setOpenOverride };
};
