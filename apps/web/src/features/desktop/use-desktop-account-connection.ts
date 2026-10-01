import { useSyncExternalStore } from "react";

import { createDesktopConnectionStore } from "@/features/desktop/desktop-connection-store.logic";
import { getAnalytics } from "@/lib/analytics/provider";
import { externalApiOrigin } from "@/lib/api-origins";
import { linkDesktopAccount } from "@/lib/desktop-bridge";

const linkAccountToRunningDesktop = async () => {
  const apiBaseUrl = externalApiOrigin();

  return await linkDesktopAccount({ apiBaseUrl });
};

const store = createDesktopConnectionStore({
  link: linkAccountToRunningDesktop,
  onError: (error) => getAnalytics().captureError(error),
});

export const useDesktopAccountConnection = () => {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getServerState,
  );

  return {
    connect: async () => await store.connect(),
    state,
  };
};
