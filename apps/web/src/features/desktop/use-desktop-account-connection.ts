import { useSyncExternalStore } from "react";

import { panic } from "better-result";

import { env } from "@/env";
import { watchForDesktopBridge } from "@/features/desktop/desktop-bridge-watch.logic";
import { createDesktopConnectionStore } from "@/features/desktop/desktop-connection-store.logic";
import { useMountEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
import { externalApiOrigin } from "@/lib/api-origins";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import {
  connectDesktopRegistry,
  connectSelfHostedDesktop,
  isDesktopAccountLinkReachable,
  linkDesktopAccount,
  readDesktopRegistryNonce,
} from "@/lib/desktop-bridge";
import { detached } from "@/lib/detached";

const linkAccountToRunningDesktop = async () => {
  const apiBaseUrl = externalApiOrigin();
  if (env.VITE_SELFHOST) {
    await connectSelfHostedDesktop({
      apiBaseUrl,
      webOrigin: window.location.origin,
    });
  }

  const linkedAccount = await getFreshLinkedAccount();
  if (!linkedAccount) {
    panic("Desktop account link ran without a signed-in account.");
  }

  await linkDesktopAccount({ apiBaseUrl, linkedAccount });
  return linkedAccount.email;
};

const connectRegistryAndAccount = async () => {
  const apiBaseUrl = externalApiOrigin();
  if (env.VITE_SELFHOST) {
    await connectSelfHostedDesktop({
      apiBaseUrl,
      webOrigin: window.location.origin,
    });
  }
  const nonce = readDesktopRegistryNonce(window.location.hash);
  if (nonce) {
    await connectDesktopRegistry({ apiBaseUrl, nonce });
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }

  return await linkAccountToRunningDesktop();
};

const store = createDesktopConnectionStore({
  link: linkAccountToRunningDesktop,
  manualLink: connectRegistryAndAccount,
  onError: (error) => getAnalytics().captureError(error),
  // A self-hosted origin is untrusted until the user runs the connect deep
  // link, and the bridge refuses an untrusted origin, so there is nothing a
  // watch could observe before that manual step.
  watch: async (signal) =>
    env.VITE_SELFHOST
      ? false
      : await watchForDesktopBridge({
          probe: isDesktopAccountLinkReachable,
          signal,
        }),
});

/**
 * Link the signed-in account to the desktop app. `startWatch` follows the
 * download the user just started, so the app connects on its own once it runs;
 * `connect` runs the same attempt for a manual button. The watch stops once it
 * has linked, once every surface has unmounted, or once its window closes.
 */
export const useDesktopAccountConnection = () => {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getServerState,
  );

  useMountEffect(() => store.retain());

  return {
    connect: async () => await store.connect(true),
    startWatch: () => {
      detached(store.startWatch(), "desktop-account-connection.watch");
    },
    state,
  };
};
