import { useState } from "react";

import { AppState } from "react-native";

import { useMountEffect } from "@stll/ui/effects";

import {
  onKeyboardDictation,
  readKeyboardStatus,
} from "@/native/keyboard-dictation";
import type { KeyboardStatus } from "@/state/keyboard-dictation";

/**
 * The keyboard's session as it changes, and when the keyboard last ran,
 * read again whenever the app comes back to the front (the keyboard runs
 * while the app is away). Null in a build without the keyboard.
 */
export const useKeyboardStatus = (): {
  status: KeyboardStatus | null;
  refresh: () => void;
} => {
  const [status, setStatus] = useState(readKeyboardStatus);
  const refresh = () => {
    setStatus(readKeyboardStatus());
  };
  useMountEffect(() => {
    const read = () => {
      setStatus(readKeyboardStatus());
    };
    const stop = onKeyboardDictation("onStatus", read);
    const foreground = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        read();
      }
    });
    return () => {
      stop();
      foreground.remove();
    };
  });
  return { status, refresh };
};
