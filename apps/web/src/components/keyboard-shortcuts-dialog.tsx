import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import {
  formatShortcutBinding,
  SHORTCUT_GROUPS,
  SHOW_SHORTCUTS_KEY,
} from "@/lib/hotkeys";

/**
 * A browsable reference of every app-level keyboard shortcut, opened with `?`.
 * Complements the transient hold-Mod overlay: both render from the single
 * `SHORTCUT_GROUPS` registry, so the two surfaces can never drift apart.
 */
export function KeyboardShortcutsDialog() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  useShowShortcutsHotkey(setOpen);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("navigation.shortcutsDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("navigation.shortcutsDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-6">
          {SHORTCUT_GROUPS.map((group) => (
            <ShortcutGroupSection group={group} key={group.categoryKey} />
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

type ShortcutGroupSectionProps = {
  group: (typeof SHORTCUT_GROUPS)[number];
};

const ShortcutGroupSection = ({ group }: ShortcutGroupSectionProps) => {
  const t = useTranslations();
  const headingId = useId();

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
          <li
            className="flex items-center justify-between gap-4 py-1"
            key={shortcut.labelKey}
          >
            <span className="text-foreground text-sm">
              {t(shortcut.labelKey)}
            </span>
            <kbd className="border-border bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
              {formatShortcutBinding(shortcut.binding)}
            </kbd>
          </li>
        ))}
      </ul>
    </section>
  );
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

/**
 * Open the cheatsheet on `?`, but never while typing. `?` cannot be a
 * TanStack `Hotkey` (see `SHOW_SHORTCUTS_KEY`), so match the produced
 * character directly, which stays correct across keyboard layouts.
 */
const useShowShortcutsHotkey = (
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
) => {
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
      if (isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    };

    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [setOpen]);
};
