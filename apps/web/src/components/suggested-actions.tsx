import type { ComponentProps, ReactNode } from "react";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

type SuggestedAction = {
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
   * `wrap` lays chips out over multiple rows; `vertical` stacks them.
   */
  orientation?: "vertical" | "wrap";
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
  "border-foreground/15 border shadow-floating [--suggested-surface:var(--color-white)] dark:[--suggested-surface:var(--popover)] bg-(--suggested-surface)";

// Translucent + slightly blurred backdrop for the `overlay` surface: chips
// float over scrolling content (the chat message list) and stay readable
// while the text behind shows through, blurred.
const OVERLAY_SURFACE_CLASS =
  "border-foreground/10 bg-background/70 border shadow-sm backdrop-blur-sm";

type SuggestedActionSurfaceProps = ComponentProps<"span"> & {
  surface: SuggestedActionSurfaceName;
};

const SuggestedActionSurface = ({
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
 * A wrapping row (or stack) of click-to-run suggested-action chips.
 */
export const SuggestedActions = ({
  actions,
  onSelect,
  label,
  orientation = "wrap",
  surface = "plain",
  keyShortcut,
  className,
}: SuggestedActionsProps) => {
  if (actions.length === 0) {
    return null;
  }

  const wraps = orientation === "wrap";

  return (
    <div
      aria-label={label}
      className={cn(
        "flex max-w-full gap-1.5",
        wraps ? "flex-wrap items-start" : "flex-col items-start",
        className,
      )}
      role="group"
    >
      {actions.map((action) => (
        <SuggestedActionSurface
          className="max-w-full"
          key={action.id}
          surface={surface}
        >
          <Button
            aria-keyshortcuts={keyShortcut}
            className={cn("text-foreground font-normal", "max-w-full")}
            onClick={() => onSelect(action.id)}
            size="chip"
            type="button"
            variant={surface === "plain" ? "outline" : "ghost"}
          >
            {action.icon}
            <span className="min-w-0 truncate" dir="auto" title={action.label}>
              {action.label}
            </span>
          </Button>
        </SuggestedActionSurface>
      ))}
    </div>
  );
};
