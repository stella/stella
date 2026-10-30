import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";

import { subscribeDesktopEvent } from "./desktop-events";
import {
  CLIPBOARD_SHORTCUT_CHANGED_EVENT,
  detectDesktopPlatform,
  isClipboardShortcutSnapshot,
} from "./shortcut-keys";
import type {
  ClipboardShortcutSnapshot,
  KeyboardLayout,
} from "./shortcut-keys";

export const DESKTOP_PLATFORM = detectDesktopPlatform(navigator.userAgent);

/** The live clipboard shortcut; `null` until the first read lands. Pass a
 *  module-level `onError` so the subscription is not rebuilt per render. */
export const useClipboardShortcut = (onError: () => void) => {
  const [snapshot, setSnapshot] = useState<ClipboardShortcutSnapshot | null>(
    null,
  );

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("shortcut_get_snapshot"),
      );
      if (disposed) {
        return;
      }
      if (
        Result.isError(result) ||
        !isClipboardShortcutSnapshot(result.value)
      ) {
        onError();
        return;
      }
      setSnapshot(result.value);
    };
    const stopListening = subscribeDesktopEvent({
      event: CLIPBOARD_SHORTCUT_CHANGED_EVENT,
      handler: () => {
        void refresh();
      },
      onError,
    });
    void refresh();
    return () => {
      disposed = true;
      stopListening();
    };
  }, [onError]);

  return [snapshot, setSnapshot] as const;
};

type LayoutMapNavigator = {
  keyboard: { getLayoutMap: () => Promise<KeyboardLayout> };
};

const hasLayoutMap = (
  value: Navigator,
): value is Navigator & LayoutMapNavigator =>
  "keyboard" in value &&
  typeof value.keyboard === "object" &&
  value.keyboard !== null &&
  "getLayoutMap" in value.keyboard &&
  typeof value.keyboard.getLayoutMap === "function";

/** The current keyboard layout where the webview exposes it (Chromium-based
 *  webviews do; WebKit does not, and labels then follow US positions). */
export const useKeyboardLayout = () => {
  const [layout, setLayout] = useState<KeyboardLayout | null>(null);

  useEffect(() => {
    if (!hasLayoutMap(navigator)) {
      return undefined;
    }
    let disposed = false;
    void Result.tryPromise(async () =>
      hasLayoutMap(navigator) ? navigator.keyboard.getLayoutMap() : null,
    ).then((result) => {
      if (!disposed && Result.isOk(result) && result.value) {
        setLayout(result.value);
      }
      return undefined;
    });
    return () => {
      disposed = true;
    };
  }, []);

  return layout;
};
