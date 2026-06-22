import type { ReactNode } from "react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

export type SuggestedAction = {
  id: string;
  label: string;
  icon?: ReactNode;
};

type SuggestedActionsProps = {
  actions: SuggestedAction[];
  onSelect: (id: string) => void;
  /** Accessible group label (callers pass a translated string). */
  label: string;
  /**
   * `horizontal` lays the chips out in a single scrolling row (each chip
   * keeps its full label); `vertical` stacks them, truncating long labels.
   */
  orientation?: "horizontal" | "vertical";
  /**
   * `plain` suits a solid background. `floating` gives each chip an opaque
   * surface so it reads cleanly over document/editor content. `overlay` is
   * translucent with a slight backdrop blur, for floating over scrolling
   * text that should stay faintly visible behind the chips.
   */
  surface?: "plain" | "floating" | "overlay";
  /** Keyboard hint surfaced on each chip via `aria-keyshortcuts`. */
  keyShortcut?: string;
  className?: string;
};

// Opaque chip backdrop for the `floating` surface: white in light mode,
// the popover token in dark, so chips read cleanly over arbitrary
// document content rather than going translucent on hover.
const FLOATING_SURFACE_CLASS =
  "border-foreground/15 border shadow-[0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)] [--suggested-surface:var(--color-white)] dark:[--suggested-surface:var(--popover)] bg-(--suggested-surface)";

// Translucent + slightly blurred backdrop for the `overlay` surface: chips
// float over scrolling content (the chat message list) and stay readable
// while the text behind shows through, blurred.
const OVERLAY_SURFACE_CLASS =
  "border-foreground/10 bg-background/70 border shadow-sm backdrop-blur-sm";

/**
 * A row (or stack) of click-to-run "suggested action" chips. Shared by the
 * chat composer's follow-up prompts and the template studio's prompt
 * presets. Horizontal chips scroll sideways so the list never wraps or
 * overflows its container.
 */
export const SuggestedActions = ({
  actions,
  onSelect,
  label,
  orientation = "horizontal",
  surface = "plain",
  keyShortcut,
  className,
}: SuggestedActionsProps) => {
  if (actions.length === 0) {
    return null;
  }

  const horizontal = orientation === "horizontal";

  return (
    <div
      aria-label={label}
      className={cn(
        "flex max-w-full gap-1.5",
        horizontal
          ? "[scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden"
          : "flex-col items-start",
        className,
      )}
      role="group"
    >
      {actions.map((action) => (
        <span
          className={cn(
            "inline-flex rounded-full",
            horizontal ? "shrink-0" : "max-w-full",
            surface === "floating" && FLOATING_SURFACE_CLASS,
            surface === "overlay" && OVERLAY_SURFACE_CLASS,
          )}
          key={action.id}
        >
          <Button
            aria-keyshortcuts={keyShortcut}
            className={cn(
              "text-foreground h-9 gap-2 rounded-full px-3 text-[13px] font-medium",
              !horizontal && "max-w-full",
            )}
            onClick={() => onSelect(action.id)}
            size="sm"
            type="button"
            variant={surface === "plain" ? "outline" : "ghost"}
          >
            {action.icon}
            <span className={cn(!horizontal && "min-w-0 truncate")}>
              {action.label}
            </span>
          </Button>
        </span>
      ))}
    </div>
  );
};
