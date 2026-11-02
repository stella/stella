"use client";

import { createContext, useContext } from "react";
import type * as React from "react";

import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";

import { cn } from "../lib/utils";
import type { ButtonSize } from "./button";
import { Toggle, type ToggleProps } from "./toggle";

const ToggleGroupSizeContext = createContext<ButtonSize>("xs");

/**
 * A segmented control: a row of toggles in one tray, of which one (or, with
 * `multiple`, several) is on. Use it for view modes, density, and filter
 * tabs over a list; `Tabs` is for switching between panels of content.
 *
 * The chosen item is raised out of the tray, so the choice reads at a glance
 * and differs from the hover fill. Arrow keys move between items and the
 * group exposes the pressed state of each.
 *
 * Base UI lets the pressed item be clicked off, leaving no value. A control
 * that must always hold one ignores an empty change in `onValueChange`.
 */
const ToggleGroup = <Value extends string>({
  className,
  size = "xs",
  ...props
}: ToggleGroupProps<Value>) => (
  <ToggleGroupSizeContext value={size}>
    <ToggleGroupPrimitive<Value>
      className={cn(
        "border-border/70 bg-muted/30 inline-flex w-fit shrink-0 items-center gap-0.5 rounded-lg border p-0.5 data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
        className,
      )}
      data-slot="toggle-group"
      {...props}
    />
  </ToggleGroupSizeContext>
);

/**
 * One choice in a `ToggleGroup`. It takes the group's size unless it names
 * its own (an icon item names an `icon-*` size and an `aria-label`, which
 * doubles as its tooltip).
 */
const ToggleGroupItem = <Value extends string>({
  className,
  size,
  variant = "muted",
  ...props
}: ToggleProps<Value>) => {
  const groupSize = useContext(ToggleGroupSizeContext);
  return (
    <Toggle<Value>
      className={cn(
        "data-pressed:bg-background data-pressed:text-foreground",
        className,
      )}
      data-slot="toggle-group-item"
      size={size ?? groupSize}
      variant={variant}
      {...props}
    />
  );
};

type ToggleGroupProps<Value extends string> =
  ToggleGroupPrimitive.Props<Value> & {
    /** The size every item takes unless it names its own. */
    size?: ButtonSize | undefined;
    children?: React.ReactNode;
  };

export { ToggleGroup, ToggleGroupItem };
export type { ToggleGroupProps };
