import { useId, useState } from "react";

import { useHotkeyRecorder } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { panic } from "better-result";
import { PencilIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import {
  formatHotkeyForPlatform,
  formatShortcutBinding,
  isEditableEventTarget,
  SHOW_SHORTCUTS_KEY,
} from "@/lib/hotkeys";
import type {
  ShortcutDescriptor,
  ShortcutGroup,
  ShortcutId,
} from "@/lib/hotkeys";
import { useKeyboardShortcutsDialogStore } from "@/lib/keyboard-shortcuts-dialog-store";
import type { RebindError } from "@/lib/shortcut-overrides";
import { useEffectiveShortcutGroups } from "@/lib/use-effective-shortcuts";
import { useShortcutEchoStore } from "@/lib/use-shortcut-echo";
import { useShortcutRebinding } from "@/lib/use-shortcut-rebinding";

/**
 * A browsable reference of every app-level keyboard shortcut, opened with `?`
 * or from the Settings entry. Renders the per-user effective registry, flashes
 * the row for whatever shortcut was just pressed, and lets the user rebind
 * hotkey-chord shortcuts in place.
 */
export const KeyboardShortcutsDialog = () => {
  const t = useTranslations();
  const { isOpen, open, setOpen } = useKeyboardShortcutsDialogStore();
  useShowShortcutsHotkey(open);

  const groups = useEffectiveShortcutGroups();

  return (
    <Dialog onOpenChange={setOpen} open={isOpen}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("navigation.shortcutsDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("navigation.shortcutsDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-6">
          {groups.map((group) => (
            <ShortcutGroupSection group={group} key={group.categoryKey} />
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
};

type ShortcutGroupSectionProps = {
  group: ShortcutGroup;
};

const ShortcutGroupSection = ({ group }: ShortcutGroupSectionProps) => {
  const t = useTranslations();
  const headingId = useId();
  const { overrides, rebind, reset } = useShortcutRebinding();

  return (
    <section aria-labelledby={headingId}>
      <h3
        className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase"
        id={headingId}
      >
        {t(group.categoryKey)}
      </h3>
      <ul className="flex flex-col gap-1">
        {group.shortcuts.map((shortcut) => (
          <ShortcutRow
            isOverridden={overrides[shortcut.id] !== undefined}
            key={shortcut.id}
            onRebind={rebind}
            onReset={reset}
            shortcut={shortcut}
          />
        ))}
      </ul>
    </section>
  );
};

type ShortcutRowProps = {
  shortcut: ShortcutDescriptor;
  isOverridden: boolean;
  onRebind: (id: ShortcutId, hotkey: Hotkey) => Promise<RebindError | null>;
  onReset: (id: ShortcutId) => Promise<void>;
};

const ShortcutRow = ({
  shortcut,
  isOverridden,
  onRebind,
  onReset,
}: ShortcutRowProps) => {
  const t = useTranslations();
  const isFlashing = useShortcutEchoStore(
    (store) => store.echo?.shortcutId === shortcut.id,
  );

  return (
    <li
      className={cn(
        "group flex items-center justify-between gap-4 rounded px-1 py-1 transition-colors",
        isFlashing && "bg-accent/60",
      )}
    >
      <span className="text-foreground text-sm">{t(shortcut.labelKey)}</span>
      {shortcut.binding.type === "hotkey" ? (
        <RebindableBinding
          hotkey={shortcut.binding.hotkey}
          id={shortcut.id}
          isOverridden={isOverridden}
          onRebind={onRebind}
          onReset={onReset}
        />
      ) : (
        <kbd className="border-border bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
          {shortcut.binding.char}
        </kbd>
      )}
    </li>
  );
};

type RebindableBindingProps = {
  id: ShortcutId;
  hotkey: Hotkey;
  isOverridden: boolean;
  onRebind: (id: ShortcutId, hotkey: Hotkey) => Promise<RebindError | null>;
  onReset: (id: ShortcutId) => Promise<void>;
};

const RebindableBinding = ({
  id,
  hotkey,
  isOverridden,
  onRebind,
  onReset,
}: RebindableBindingProps) => {
  const t = useTranslations();
  const hotkeyPlatform = useHydrationSafeHotkeyPlatform();
  const [pending, setPending] = useState<Hotkey | null>(null);
  const [rebindError, setRebindError] = useState<RebindError | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const recorder = useHotkeyRecorder({
    onRecord: (recorded) => {
      setPending(recorded);
    },
  });

  const isEditing = recorder.isRecording || pending !== null;
  const preview = pending ?? recorder.recordedHotkey;

  const startEdit = () => {
    setRebindError(null);
    setPending(null);
    recorder.startRecording();
  };

  const cancelEdit = () => {
    recorder.cancelRecording();
    setPending(null);
    setRebindError(null);
  };

  const save = async () => {
    if (!pending) {
      return;
    }
    setIsBusy(true);
    setRebindError(null);
    try {
      const rejection = await onRebind(id, pending);
      if (rejection) {
        setRebindError(rejection);
        return;
      }
      setPending(null);
    } catch (error) {
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    } finally {
      setIsBusy(false);
    }
  };

  const resetToDefault = async () => {
    setIsBusy(true);
    try {
      await onReset(id);
    } catch (error) {
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    } finally {
      setIsBusy(false);
    }
  };

  const errorText = (() => {
    if (!rebindError) {
      return null;
    }
    switch (rebindError.type) {
      case "collision":
        return t("navigation.shortcutsDialog.collision", {
          label: t(rebindError.conflictLabelKey),
        });
      case "invalidBinding":
        return t("navigation.shortcutsDialog.invalidBinding");
      case "notRebindable":
        return t("navigation.shortcutsDialog.notRebindable");
      default: {
        rebindError satisfies never;
        return panic(`Unhandled rebind error: ${String(rebindError)}`);
      }
    }
  })();

  if (isEditing) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <kbd className="border-primary bg-muted text-foreground min-w-16 rounded border border-dashed px-1.5 py-0.5 text-center text-xs">
            {preview
              ? formatHotkeyForPlatform(preview, hotkeyPlatform)
              : t("navigation.shortcutsDialog.pressKeys")}
          </kbd>
          <Button
            disabled={!pending || isBusy}
            onClick={() => {
              detached(save(), "keyboard-shortcuts-dialog.save");
            }}
            size="sm"
            variant="default"
          >
            {t("common.save")}
          </Button>
          <Button onClick={cancelEdit} size="sm" variant="ghost">
            {t("common.cancel")}
          </Button>
        </div>
        {errorText ? (
          <span className="text-destructive text-xs">{errorText}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {isOverridden ? (
        <Button
          disabled={isBusy}
          onClick={() => {
            detached(resetToDefault(), "keyboard-shortcuts-dialog.reset");
          }}
          size="sm"
          variant="ghost"
        >
          {t("navigation.shortcutsDialog.resetToDefault")}
        </Button>
      ) : null}
      <kbd className="border-border bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
        {formatShortcutBinding({ type: "hotkey", hotkey }, hotkeyPlatform)}
      </kbd>
      <Button
        // Quiet entry affordance: hidden until the row is hovered or receives
        // keyboard focus. `focus-visible:opacity-100` keeps it reachable by
        // Tab even when the pointer never touches the row (a11y), so it is not
        // hover-only.
        aria-label={t("navigation.shortcutsDialog.editShortcut")}
        className={cn(
          "text-muted-foreground opacity-0 transition-opacity",
          "group-focus-within:opacity-100 group-hover:opacity-100",
          "focus-visible:opacity-100",
        )}
        disabled={isBusy}
        onClick={startEdit}
        size="icon-sm"
        variant="ghost"
      >
        <PencilIcon className="size-3.5" />
      </Button>
    </div>
  );
};

/**
 * Open the cheatsheet on `?`, but never while typing. `?` cannot be a
 * TanStack `Hotkey` (see `SHOW_SHORTCUTS_KEY`), so match the produced
 * character directly, which stays correct across keyboard layouts.
 */
const useShowShortcutsHotkey = (open: () => void) => {
  useExternalSyncEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      if (event.key !== SHOW_SHORTCUTS_KEY) {
        return;
      }
      // `?` is Shift + a layout-dependent key; a further Ctrl/Meta/Alt means
      // the user is reaching for a different chord, not the cheatsheet.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (isEditableEventTarget(event.target)) {
        return;
      }
      event.preventDefault();
      open();
    };

    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [open]);
};
