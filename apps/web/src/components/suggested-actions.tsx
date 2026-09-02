import type { ComponentProps, ReactNode } from "react";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

export type SuggestedAction = {
  id: string;
  label: string;
  icon?: ReactNode;
};

export type SuggestedActionSurfaceName = "plain" | "floating" | "overlay";

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
  surface?: SuggestedActionSurfaceName;
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

type SuggestedActionSurfaceProps = ComponentProps<"span"> & {
  surface: SuggestedActionSurfaceName;
};

export const SuggestedActionSurface = ({
  className,
  surface,
  ...props
}: SuggestedActionSurfaceProps) => (
  <span
    className={cn(
      "inline-flex rounded-full",
      surface === "floating" && FLOATING_SURFACE_CLASS,
      surface === "overlay" && OVERLAY_SURFACE_CLASS,
      className,
    )}
    {...props}
  />
);

/**
 * A row (or stack) of click-to-run "suggested action" chips. Horizontal
 * chips scroll sideways so the list never wraps or overflows its container;
 * the row's trailing edge fades so a clipped chip reads as "more to scroll"
 * instead of a hard cut. The row shows no scrollbar: the fade carries the
 * overflow signal, and a scrollbar track would add height only when the
 * chips overflow, so the gap to the composer below would depend on content.
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
          ? "scrollbar-none overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] rtl:[mask-image:linear-gradient(to_left,black_calc(100%-2.5rem),transparent)]"
          : "flex-col items-start",
        className,
      )}
      role="group"
    >
      {actions.map((action) => (
        <SuggestedActionSurface
          className={cn(horizontal ? "shrink-0" : "max-w-full")}
          key={action.id}
          surface={surface}
        >
          <Button
            aria-keyshortcuts={keyShortcut}
            className={cn(
              "text-foreground font-normal",
              !horizontal && "max-w-full",
            )}
            onClick={() => onSelect(action.id)}
            size="chip"
            type="button"
            variant={surface === "plain" ? "outline" : "ghost"}
          >
            {action.icon}
            <span className={cn(!horizontal && "min-w-0 truncate")} dir="auto">
              {action.label}
            </span>
          </Button>
        </SuggestedActionSurface>
      ))}
    </div>
  );
};
