"use client";

import { useId } from "react";
import type * as React from "react";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../lib/utils";

/**
 * `default` is a setting's own control; `sm` sits in a dense row or a menu
 * beside small type.
 */
type SwitchSize = "sm" | "default";

const SWITCH_ROOT_SIZE_CLASS_NAME = {
  default: "h-5 w-9",
  sm: "h-4 w-7",
} as const satisfies Record<SwitchSize, string>;

const SWITCH_THUMB_SIZE_CLASS_NAME = {
  default:
    "size-4 ltr:data-checked:translate-x-4.5 ltr:data-unchecked:translate-x-0.5 rtl:data-checked:-translate-x-4.5 rtl:data-unchecked:-translate-x-0.5",
  sm: "size-3 ltr:data-checked:translate-x-3.5 ltr:data-unchecked:translate-x-0.5 rtl:data-checked:-translate-x-3.5 rtl:data-unchecked:-translate-x-0.5",
} as const satisfies Record<SwitchSize, string>;

type SwitchProps = SwitchPrimitive.Root.Props & {
  size?: SwitchSize | undefined;
};

const Switch = ({ className, size = "default", ...props }: SwitchProps) => (
  <SwitchPrimitive.Root
    className={cn(
      "focus-visible:ring-ring focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input relative inline-flex shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-1 data-disabled:opacity-64",
      SWITCH_ROOT_SIZE_CLASS_NAME[size],
      className,
    )}
    data-size={size}
    data-slot="switch"
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "bg-background pointer-events-none block rounded-full shadow-xs transition-transform",
        SWITCH_THUMB_SIZE_CLASS_NAME[size],
      )}
      data-slot="switch-thumb"
    />
  </SwitchPrimitive.Root>
);

/**
 * A setting row: its label and an optional description at the start, the
 * switch at the end. The whole row is the label, so a click anywhere on it
 * flips the switch, and the row is at least 44px tall for touch. The
 * description is linked to the switch, so it is read after the name.
 */
const SwitchField = ({
  className,
  description,
  label,
  size,
  ...props
}: SwitchProps & {
  label: React.ReactNode;
  description?: React.ReactNode;
}) => {
  const descriptionId = useId();
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center justify-between gap-4 py-2 has-data-disabled:cursor-not-allowed",
        className,
      )}
      data-slot="switch-field"
    >
      {/* The switch dims itself when disabled; the text dims beside it. */}
      <span className="flex min-w-0 flex-col gap-0.5 in-[label:has([data-disabled])]:opacity-64">
        <span className="text-foreground text-sm font-medium">{label}</span>
        {description === undefined ? null : (
          <span
            className="text-muted-foreground text-xs"
            data-slot="switch-field-description"
            id={descriptionId}
          >
            {description}
          </span>
        )}
      </span>
      <Switch
        aria-describedby={description === undefined ? undefined : descriptionId}
        size={size}
        {...props}
      />
    </label>
  );
};

export { Switch, SwitchField };
export type { SwitchProps, SwitchSize };
