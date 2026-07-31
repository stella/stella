"use client";

import type { ComponentType } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";
import { cn } from "@stll/ui/lib/utils";

type SegmentedIconToggleOption<T extends string> = {
  value: T;
  icon: ComponentType<{ className?: string }>;
  /** Already-translated label; shown as a tooltip and the accessible name. */
  label: string;
};

type SegmentedIconToggleProps<T extends string> = {
  value: T;
  options: readonly SegmentedIconToggleOption<T>[];
  onChange: (value: T) => void;
  size?: "compact" | "touch";
};

/** Compact segmented control of icon buttons (e.g. table row wrap, list
 * density). One shared shell so every density/mode switch looks and behaves
 * the same across the app. */
export const SegmentedIconToggle = <T extends string>({
  value,
  options,
  onChange,
  size = "compact",
}: SegmentedIconToggleProps<T>) => (
  <div
    className={cn(
      "border-border/70 bg-muted/30 inline-flex shrink-0 items-center overflow-hidden rounded-md border p-0.5",
      size === "touch" ? "h-7 [@media(any-pointer:coarse)]:h-11" : "h-7",
    )}
  >
    {options.map((option) => {
      const Icon = option.icon;
      const isActive = value === option.value;
      return (
        <Tooltip key={option.value}>
          <TooltipTrigger
            render={
              <Button
                aria-label={option.label}
                aria-pressed={isActive}
                className={cn(
                  "text-muted-foreground h-6 min-h-0 w-7 rounded-[4px] p-0",
                  size === "touch" &&
                    "[@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:min-h-10 [@media(any-pointer:coarse)]:w-11",
                  isActive &&
                    "bg-muted text-foreground ring-border/80 hover:bg-muted hover:text-foreground shadow-xs ring-1",
                )}
                onClick={() => onChange(option.value)}
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{option.label}</TooltipPopup>
        </Tooltip>
      );
    })}
  </div>
);
