import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useHotkey, useKeyHold } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { useMatch } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Dialog, DialogPopup } from "@stll/ui/components/dialog";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import {
  formatHintKey,
  MOD_KEY,
  SHORTCUT_HINT_GROUPS,
  triggerHotkey,
} from "@/lib/hotkeys";
import type { ShortcutContext, ShortcutHint } from "@/lib/hotkeys";

const HOLD_DELAY_MS = 500;
const HIGHLIGHT_DURATION_MS = 150;
const SHORTCUT_HINTS_MIN_WIDTH_PX = 768;
const SHORTCUT_HINTS_MEDIA_QUERY = `(min-width: ${SHORTCUT_HINTS_MIN_WIDTH_PX}px)`;

export function ShortcutHintsOverlay() {
  const shouldRenderShortcutHints = useShortcutHintsViewport();

  if (!shouldRenderShortcutHints) {
    return null;
  }

  return <ShortcutHintsOverlayContent />;
}

function ShortcutHintsOverlayContent() {
  const t = useTranslations();
  const isModHeld = useKeyHold(MOD_KEY);
  const isMountedRef = useRef(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isSuppressedUntilRelease, setIsSuppressedUntilRelease] =
    useState(false);

  const showDialog = useDebouncedCallback(() => {
    if (isMountedRef.current) {
      setIsVisible(true);
    }
  }, HOLD_DELAY_MS);

  useMountEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      showDialog.cancel();
    };
  });

  // Cancel overlay when any non-modifier key is pressed with Mod
  // held (the user is executing a shortcut, not browsing hints).
  // Also cancel on Mod+Click (e.g. multi-select in filesystem).
  // Uses capture phase so it fires before React hotkey handlers.
  useExternalSyncEffect(() => {
    const cancel = () => {
      showDialog.cancel();
      setIsVisible(false);
    };

    const suppressUntilRelease = () => {
      setIsSuppressedUntilRelease(true);
      cancel();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) {
        return;
      }
      const { key } = e;
      if (key === "Meta" || key === "Control") {
        return;
      }
      suppressUntilRelease();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") {
        setIsSuppressedUntilRelease(false);
        cancel();
      }
    };

    const onBlur = () => {
      setIsSuppressedUntilRelease(false);
      cancel();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        onBlur();
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) {
        suppressUntilRelease();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [showDialog]);

  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- reacts to the useKeyHold(MOD_KEY) hook output plus suppression state; the trigger is a hook return value with no setter call-site to relay into, so it stays an effect
  useEffect(() => {
    if (isModHeld && !isSuppressedUntilRelease) {
      showDialog();
    } else {
      showDialog.cancel();
      // eslint-disable-next-line react/react-compiler -- effect reacts to the useKeyHold hook output and drives a debounced dialog side effect; not derivable in render
      setIsVisible(false);
    }
  }, [isModHeld, isSuppressedUntilRelease, showDialog]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setIsSuppressedUntilRelease(true);
      showDialog.cancel();
    }
    setIsVisible(open);
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={isVisible}>
      <DialogPopup className="w-64 p-4" initialFocus={false} showCloseButton>
        <div className="flex flex-col gap-3">
          {SHORTCUT_HINT_GROUPS.map((group) => (
            <div key={group.categoryKey}>
              <h3 className="text-muted-foreground mb-1 px-2 text-xs font-medium">
                {t(group.categoryKey)}
              </h3>
              <div className="flex flex-col gap-0.5">
                {group.hints.map((hint) => (
                  <HotkeyHint
                    hint={hint}
                    key={hint.hotkey}
                    setIsVisible={setIsVisible}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

const subscribeShortcutHintsViewport = (callback: () => void) => {
  const mediaQuery = window.matchMedia(SHORTCUT_HINTS_MEDIA_QUERY);
  mediaQuery.addEventListener("change", callback);

  return () => {
    mediaQuery.removeEventListener("change", callback);
  };
};

const getShortcutHintsViewportSnapshot = () =>
  window.matchMedia(SHORTCUT_HINTS_MEDIA_QUERY).matches;

const getShortcutHintsViewportServerSnapshot = () => false;

const useShortcutHintsViewport = () =>
  useSyncExternalStore(
    subscribeShortcutHintsViewport,
    getShortcutHintsViewportSnapshot,
    getShortcutHintsViewportServerSnapshot,
  );

const useShortcutContext = (): ShortcutContext => {
  const pdfMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId/document",
    shouldThrow: false,
  });
  const projectMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/",
    shouldThrow: false,
  });

  if (pdfMatch) {
    return "pdf";
  }

  if (projectMatch) {
    return "workspace";
  }

  return "global";
};

type HotkeyHintProps = {
  hint: ShortcutHint;
  setIsVisible: React.Dispatch<React.SetStateAction<boolean>>;
};

const HotkeyHint = ({ hint, setIsVisible }: HotkeyHintProps) => {
  const t = useTranslations();
  const context = useShortcutContext();
  const isActive = hint.contexts.some((c) => c === "global" || c === context);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(false);
  const [isActivated, setIsActivated] = useState(false);

  useMountEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  });

  const handleActivateHotkey = (hotkey?: Hotkey) => {
    if (!isMountedRef.current) {
      return;
    }

    setIsActivated(true);

    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current);
    }

    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = null;
      if (!isMountedRef.current) {
        return;
      }
      setIsVisible(false);
      setIsActivated(false);
      if (hotkey) {
        triggerHotkey(hotkey);
      }
    }, HIGHLIGHT_DURATION_MS);
  };

  useHotkey(hint.hotkey, () => {
    handleActivateHotkey();
  });

  return (
    <Button
      className={cn(
        "flex h-auto w-full items-center",
        "justify-between px-2 py-1.5",
        "transition-colors duration-150",
        (() => {
          if (isActivated) {
            return "bg-accent text-accent-foreground";
          }
          if (isActive) {
            return "text-foreground";
          }
          return "text-foreground-disabled";
        })(),
      )}
      key={hint.hotkey}
      onClick={() => handleActivateHotkey(hint.hotkey)}
      size="sm"
      variant="ghost"
    >
      <span>{t(hint.labelKey)}</span>
      <kbd
        className={cn(
          "rounded border px-1.5 py-0.5",
          "text-[0.625rem]",
          (() => {
            if (isActivated) {
              return "border-border bg-background text-foreground";
            }
            if (isActive) {
              return "border-border bg-muted text-muted-foreground";
            }
            return "bg-muted/40 text-foreground-disabled border-transparent";
          })(),
        )}
      >
        {formatHintKey(hint.hotkey)}
      </kbd>
    </Button>
  );
};
