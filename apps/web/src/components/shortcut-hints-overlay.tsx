import { useEffect, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Dialog, DialogPopup } from "@stll/ui/components/dialog";
import { cn } from "@stll/ui/lib/utils";
import { useHotkey, useKeyHold } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { useMatch } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import {
  formatHintKey,
  MOD_KEY,
  SHORTCUT_HINT_GROUPS,
  triggerHotkey,
} from "@/lib/hotkeys";
import type { ShortcutContext, ShortcutHint } from "@/lib/hotkeys";

const HOLD_DELAY_MS = 500;
const HIGHLIGHT_DURATION_MS = 150;

export function ShortcutHintsOverlay() {
  const t = useTranslations();
  const isModHeld = useKeyHold(MOD_KEY);
  const [isVisible, setIsVisible] = useState(false);
  const [isSuppressedUntilRelease, setIsSuppressedUntilRelease] =
    useState(false);

  const showDialog = useDebouncedCallback(
    () => setIsVisible(true),
    HOLD_DELAY_MS,
  );

  // Cancel overlay when any non-modifier key is pressed with Mod
  // held (the user is executing a shortcut, not browsing hints).
  // Also cancel on Mod+Click (e.g. multi-select in filesystem).
  // Uses capture phase so it fires before React hotkey handlers.
  useEffect(() => {
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

  useEffect(() => {
    if (isModHeld && !isSuppressedUntilRelease) {
      showDialog();
    } else {
      showDialog.cancel();
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

const useShortcutContext = (): ShortcutContext => {
  const pdfMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
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
  const [isActivated, setIsActivated] = useState(false);

  const handleActivateHotkey = (hotkey?: Hotkey) => {
    setIsActivated(true);

    setTimeout(() => {
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
        isActivated
          ? "bg-accent text-accent-foreground"
          : isActive
            ? "text-foreground"
            : "text-muted-foreground/40",
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
          isActivated
            ? "border-border bg-background text-foreground"
            : isActive
              ? "border-border bg-muted text-muted-foreground"
              : "bg-muted/40 text-muted-foreground/40 border-transparent",
        )}
      >
        {formatHintKey(hint.hotkey)}
      </kbd>
    </Button>
  );
};
