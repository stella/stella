import type { ReactNode } from "react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

/**
 * Selected filter/toggle pill. Inverts to a solid `foreground` fill with
 * `background` text so it reads as "on" in both themes.
 *
 * The interactive states are pinned in the SAME arbitrary-variant syntax
 * the Button `ghost`/`outline` variants use (`[:hover,[data-pressed]]:`,
 * `data-pressed:`, `dark:…`). A plain `hover:` utility does NOT merge
 * against the variant's `[:hover,[data-pressed]]:bg-accent`, so both
 * survive and the translucent `accent` wins on hover — leaving light
 * `background` text on a light `accent` fill (unreadable). Matching the
 * modifier lets tailwind-merge dedupe the background so the fill stays
 * `foreground` across hover, press, light, and dark.
 */
const SELECTED_TOGGLE_CHIP_CLASS =
  "border-foreground bg-foreground text-background dark:bg-foreground " +
  "[:hover,[data-pressed]]:bg-foreground [:hover,[data-pressed]]:text-background " +
  "dark:[:hover,[data-pressed]]:bg-foreground data-pressed:bg-foreground";

type ToggleChipProps = {
  active: boolean;
  children: ReactNode;
  className?: string;
  onClick: () => void;
  variant?: "ghost" | "outline";
};

export function ToggleChip({
  active,
  children,
  className,
  onClick,
  // No `= "outline"` default in the pattern: react-compiler 1.0.0 bails
  // on AssignmentPattern property values (BuildHIR::lowerAssignment Todo),
  // so the default is applied at the use site instead.
  variant,
}: ToggleChipProps) {
  return (
    <Button
      aria-pressed={active}
      className={cn(
        "h-auto rounded-md px-2 py-0.5 text-xs transition-colors",
        active ? SELECTED_TOGGLE_CHIP_CLASS : "text-muted-foreground",
        className,
      )}
      onClick={onClick}
      size="sm"
      type="button"
      variant={variant ?? "outline"}
    >
      {children}
    </Button>
  );
}
