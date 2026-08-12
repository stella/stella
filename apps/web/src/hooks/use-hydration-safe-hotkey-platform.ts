import { useSyncExternalStore } from "react";

import { detectPlatform } from "@tanstack/react-hotkeys";

import { resolveHydrationSafeHotkeyPlatform } from "@/lib/hotkeys";
import type { HotkeyPlatform } from "@/lib/hotkeys";

const subscribeToPlatform = (_onStoreChange: () => void) => () => undefined;

const getServerPlatform = (): HotkeyPlatform =>
  resolveHydrationSafeHotkeyPlatform({
    status: "pre-mount",
    detected: detectPlatform(),
  });

const getBrowserPlatform = (): HotkeyPlatform =>
  resolveHydrationSafeHotkeyPlatform({
    status: "mounted",
    detected: detectPlatform(),
  });

/**
 * Returns the canonical SSR platform through hydration, then the browser's
 * actual platform after mount. Use this for every shortcut rendered as text.
 */
export const useHydrationSafeHotkeyPlatform = (): HotkeyPlatform =>
  useSyncExternalStore(
    subscribeToPlatform,
    getBrowserPlatform,
    getServerPlatform,
  );
