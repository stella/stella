import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";
import { formatShortcutBinding } from "@/lib/hotkeys";
import { useEffectiveShortcutGroups } from "@/lib/use-effective-shortcuts";
import {
  useShortcutEchoListener,
  useShortcutEchoStore,
} from "@/lib/use-shortcut-echo";
import type { EchoCandidate } from "@/lib/use-shortcut-echo";

/**
 * Unobtrusive "what did I just press" affordance. A global capture-phase
 * listener recognizes any real shortcut from the effective registry; on a
 * match a small chip (e.g. `⌘K · Search`) flashes in the corner, even when the
 * cheatsheet is closed. Because it matches against the effective registry, it
 * can only ever show a shortcut that actually exists.
 */
export const ShortcutEchoHud = () => {
  const t = useTranslations();
  const hotkeyPlatform = useHydrationSafeHotkeyPlatform();
  const groups = useEffectiveShortcutGroups();

  const candidates: EchoCandidate[] = groups.flatMap((group) =>
    group.shortcuts.map((shortcut) => ({
      id: shortcut.id,
      binding: shortcut.binding,
    })),
  );
  useShortcutEchoListener(candidates);

  const echo = useShortcutEchoStore((store) => store.echo);

  const active = groups
    .flatMap((group) => group.shortcuts)
    .find((shortcut) => shortcut.id === echo?.shortcutId);

  if (!echo || !active) {
    return null;
  }

  return (
    <output
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center"
    >
      <div
        // `echo.at` as the key remounts the chip on each press so a repeated
        // shortcut re-runs the entrance animation.
        className={cn(
          "bg-popover text-popover-foreground border-border flex items-center gap-2",
          "rounded-full border px-3 py-1.5 shadow-md",
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2",
        )}
        key={echo.at}
      >
        <kbd className="border-border bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
          {formatShortcutBinding(active.binding, hotkeyPlatform)}
        </kbd>
        <span className="text-foreground text-sm">·</span>
        <span className="text-foreground text-sm">{t(active.labelKey)}</span>
      </div>
    </output>
  );
};
