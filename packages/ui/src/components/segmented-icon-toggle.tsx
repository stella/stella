"use client";

import type { ComponentType } from "react";

import { cn } from "../lib/utils";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

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
 * the same across the app. A `ToggleGroup` of icon items that always holds
 * one value: clicking the chosen option keeps it. */
export const SegmentedIconToggle = <T extends string>({
  value,
  options,
  onChange,
  size = "compact",
}: SegmentedIconToggleProps<T>) => (
  <ToggleGroup<T>
    className={cn(
      "rounded-md",
      size === "touch" ? "h-7 [@media(any-pointer:coarse)]:h-12" : "h-7",
    )}
    data-slot="segmented-icon-toggle"
    onValueChange={(next) => {
      const [chosen] = next;
      if (chosen !== undefined && chosen !== value) {
        onChange(chosen);
      }
    }}
    value={[value]}
  >
    {options.map((option) => {
      const Icon = option.icon;
      return (
        <ToggleGroupItem<T>
          aria-label={option.label}
          className={cn(
            "h-6 w-7 rounded-[4px] sm:h-6",
            size === "touch" &&
              "[@media(any-pointer:coarse)]:h-11 [@media(any-pointer:coarse)]:w-11",
          )}
          data-control-value={option.value}
          key={option.value}
          size="icon-xs"
          value={option.value}
        >
          <Icon className="size-3.5" />
        </ToggleGroupItem>
      );
    })}
  </ToggleGroup>
);
