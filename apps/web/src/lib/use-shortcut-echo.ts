import { matchesKeyboardEvent } from "@tanstack/react-hotkeys";
import { panic } from "better-result";
import { create } from "zustand";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { isEditableEventTarget } from "@/lib/hotkeys";
import type { ShortcutBinding, ShortcutId } from "@/lib/hotkeys";

/** How long a press echo stays visible before auto-clearing. */
export const SHORTCUT_ECHO_DURATION_MS = 1200;

export type ShortcutEcho = {
  readonly shortcutId: ShortcutId;
  /** Monotonic-ish timestamp; changes on each press so repeats re-trigger. */
  readonly at: number;
};

type ShortcutEchoStore = {
  readonly echo: ShortcutEcho | null;
  readonly flash: (shortcutId: ShortcutId) => void;
  readonly clear: () => void;
};

let clearTimer: ReturnType<typeof setTimeout> | null = null;

export const useShortcutEchoStore = create<ShortcutEchoStore>((set) => ({
  echo: null,
  flash: (shortcutId) => {
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
    }
    set({ echo: { shortcutId, at: Date.now() } });
    clearTimer = setTimeout(() => {
      clearTimer = null;
      set({ echo: null });
    }, SHORTCUT_ECHO_DURATION_MS);
  },
  clear: () => {
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    set({ echo: null });
  },
}));

export type EchoCandidate = {
  readonly id: ShortcutId;
  readonly binding: ShortcutBinding;
};

const matchEchoCandidate = (
  candidates: readonly EchoCandidate[],
  event: KeyboardEvent,
): ShortcutId | null => {
  for (const candidate of candidates) {
    const { binding } = candidate;
    switch (binding.type) {
      case "hotkey": {
        if (matchesKeyboardEvent(event, binding.hotkey)) {
          return candidate.id;
        }
        break;
      }
      case "char": {
        if (
          event.key === binding.char &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          return candidate.id;
        }
        break;
      }
      default: {
        binding satisfies never;
        return panic(`Unhandled binding: ${String(binding)}`);
      }
    }
  }
  return null;
};

/**
 * Global capture-phase listener that recognizes when the user presses a real,
 * currently-registered shortcut and records which one, so the cheatsheet row
 * and the HUD chip can flash it. It can only ever surface a shortcut that
 * exists in the effective registry, so it cannot drift from real behavior.
 *
 * Shares the typing guard with the `?` handler: never fires while the user is
 * editing text. The handler is a `useLatestCallback` so the listener subscribes
 * once yet always matches against the current effective registry, even as that
 * array changes identity.
 */
export const useShortcutEchoListener = (
  candidates: readonly EchoCandidate[],
): void => {
  const flash = useShortcutEchoStore((store) => store.flash);

  const onKeyDown = useLatestCallback((event: KeyboardEvent) => {
    if (event.repeat || event.defaultPrevented) {
      return;
    }
    if (isEditableEventTarget(event.target)) {
      return;
    }
    const matched = matchEchoCandidate(candidates, event);
    if (matched !== null) {
      flash(matched);
    }
  });

  useExternalSyncEffect(() => {
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [onKeyDown]);
};
