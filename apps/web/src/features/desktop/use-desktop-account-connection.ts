import { useSyncExternalStore } from "react";

import { createDesktopConnectionStore } from "@/features/desktop/desktop-connection-store.logic";
import type { DesktopLinkApproval } from "@/features/desktop/desktop-connection-store.logic";
import { getAnalytics } from "@/lib/analytics/provider";
import { externalApiOrigin } from "@/lib/api-origins";
import { linkDesktopAccount } from "@/lib/desktop-bridge";

const store = createDesktopConnectionStore({
  link: async (options) =>
    await linkDesktopAccount({ ...options, apiBaseUrl: externalApiOrigin() }),
  onError: (error) =>
    getAnalytics().captureError(error, {
      fingerprintKey: "use-desktop-account-connection:failure",
      scope: {
        type: "handler",
        handlerId: "use-desktop-account-connection:failure",
      },
    }),
});

export const useDesktopAccountConnection = () => {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getServerState,
  );

  return {
    connect: async (approval: DesktopLinkApproval) =>
      await store.connect(approval),
    state,
  };
};
