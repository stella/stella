"use client";

import type * as React from "react";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";

import { Button, type ButtonSize } from "./button";

/**
 * A button that stays pressed: a formatting mark, "show resolved", a pinned
 * view. It is a `Button` underneath, so it shares the button's sizes, focus
 * ring, tooltip and disabled disposition, and its pressed state is the
 * button's selected treatment, distinct from hover. Base UI owns
 * `aria-pressed`.
 *
 * Several toggles that choose one value (view modes, filter tabs) are a
 * `ToggleGroup`, not a row of these.
 */
const Toggle = <Value extends string>({
  size = "sm",
  tooltip,
  variant = "muted",
  ...props
}: ToggleProps<Value>) => (
  <TogglePrimitive<Value>
    data-slot="toggle"
    render={<Button size={size} tooltip={tooltip} variant={variant} />}
    {...props}
  />
);

/** The quiet button looks a pressed state reads well on. */
type ToggleVariant = "ghost" | "muted" | "outline";

type ToggleProps<Value extends string> = TogglePrimitive.Props<Value> & {
  size?: ButtonSize | undefined;
  /** The hint, and the accessible name source for an icon size. */
  tooltip?: React.ReactNode;
  variant?: ToggleVariant | undefined;
};

export { Toggle };
export type { ToggleProps, ToggleVariant };
