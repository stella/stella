import { useSyncExternalStore } from "react";

import {
  type DesktopPlatform,
  detectDesktopPlatform,
} from "@/lib/desktop-downloads";

const subscribeToPlatform = (_onStoreChange: () => void) => () => undefined;
const getServerPlatform = (): DesktopPlatform => "other";

/**
 * Keeps server markup through hydration, then switches to the browser platform.
 */
export const useHydrationSafeDesktopPlatform = (): DesktopPlatform =>
  useSyncExternalStore(
    subscribeToPlatform,
    detectDesktopPlatform,
    getServerPlatform,
  );
