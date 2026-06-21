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
 * Vertical stack of click-to-run "suggested action" chips. Stacking
 * (rather than a wrapping row) keeps long labels on their own line and
 * truncating, so the list never overflows its container. Shared by the
 * chat composer's follow-up prompts and the template studio's prompt
 * presets.
 */
export const SuggestedActions = ({
  actions,
  onSelect,
  label,
  surface = "plain",
  keyShortcut,
  className,
}: SuggestedActionsProps) => {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={label}
      className={cn("flex max-w-full flex-col items-start gap-1.5", className)}
      role="group"
    >
      {actions.map((action) => (
        <span
          className={cn(
            "inline-flex max-w-full rounded-full",
            surface === "floating" && FLOATING_SURFACE_CLASS,
            surface === "overlay" && OVERLAY_SURFACE_CLASS,
          )}
          key={action.id}
        >
          <Button
            aria-keyshortcuts={keyShortcut}
            className="text-foreground h-9 max-w-full gap-2 rounded-full px-3 text-[13px] font-medium"
            onClick={() => onSelect(action.id)}
            size="sm"
            type="button"
            variant={surface === "plain" ? "outline" : "ghost"}
          >
            {action.icon}
            <span className="min-w-0 truncate">{action.label}</span>
          </Button>
        </span>
      ))}
    </div>
  );
};
