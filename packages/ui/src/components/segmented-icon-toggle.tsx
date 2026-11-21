"use client";

import type { ComponentType } from "react";

import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import {
  SEGMENTED_ICON_TOGGLE_ICON_CLASS_NAME,
  segmentedIconToggleClassName,
  segmentedIconToggleItemClassName,
} from "./toggle-group-classes";
import type { SegmentedIconToggleSize } from "./toggle-group-classes";

type SegmentedIconToggleOption<T extends string> = {
  /** A fixed id for the option, where generated ones would differ per mount. */
  id?: string | undefined;
  value: T;
  icon: ComponentType<{ className?: string }>;
  /** Already-translated label; shown as a tooltip and the accessible name. */
  label: string;
};

type SegmentedIconToggleProps<T extends string> = {
  value: T;
  options: readonly SegmentedIconToggleOption<T>[];
  onChange: (value: T) => void;
  size?: SegmentedIconToggleSize;
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
    className={segmentedIconToggleClassName(size)}
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
          className={segmentedIconToggleItemClassName(size)}
          data-control-value={option.value}
          id={option.id}
          key={option.value}
          size="icon-xs"
          value={option.value}
        >
          <Icon className={SEGMENTED_ICON_TOGGLE_ICON_CLASS_NAME} />
        </ToggleGroupItem>
      );
    })}
  </ToggleGroup>
);
