"use client";

import type { ReactNode } from "react";

import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";

import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { cn } from "../lib/utils";
import {
  INPUT_CONTROL_CLASS_NAME,
  INPUT_ELEMENT_CLASS_NAME,
  INPUT_SIZE_CLASS_NAMES,
} from "./input-control";

type NumberInputProps = Omit<
  NumberFieldPrimitive.Root.Props,
  "children" | "className" | "render"
> & {
  className?: string;
  inputClassName?: string;
  inputProps?: Omit<
    NumberFieldPrimitive.Input.Props,
    | "className"
    | "defaultValue"
    | "id"
    | "onChange"
    | "render"
    | "type"
    | "value"
  >;
  size?: ControlSize;
  /**
   * The unit the value is in ("pt", "%"), shown muted at the end of the
   * control so the number reads with its unit while the typed text stays a
   * bare number.
   */
  suffix?: ReactNode;
};

/**
 * A numeric control that keeps the user's editable text separate from its
 * canonical numeric value. Parsed changes are reported through `onValueChange`;
 * formatting and clamping happen only at Base UI's commit boundaries.
 */
const NumberInput = ({
  className,
  inputClassName,
  inputProps,
  dir = "ltr",
  size = CONTROL_SIZE.default,
  suffix,
  ...props
}: NumberInputProps) => (
  <NumberFieldPrimitive.Root
    {...props}
    className={cn(INPUT_CONTROL_CLASS_NAME, className)}
    data-size={size}
    data-slot="number-input-control"
    dir={dir}
    render={undefined}
  >
    <NumberFieldPrimitive.Input
      {...inputProps}
      className={cn(
        INPUT_ELEMENT_CLASS_NAME,
        INPUT_SIZE_CLASS_NAMES[size],
        "tabular-nums",
        suffix !== undefined && "pe-1",
        inputClassName,
      )}
      data-slot="number-input"
      // The field steps with the arrow keys, so assistive technology hears a
      // spin button with its bounds and current value rather than a text box.
      render={(inputElementProps, state) => (
        <input
          {...inputElementProps}
          aria-valuemax={props.max}
          aria-valuemin={props.min}
          aria-valuenow={state.value ?? undefined}
          dir={dir}
          role="spinbutton"
        />
      )}
    />
    {suffix === undefined ? null : (
      <span
        className="text-muted-foreground pointer-events-none flex shrink-0 items-center pe-2.5 text-xs"
        data-slot="number-input-suffix"
      >
        {suffix}
      </span>
    )}
  </NumberFieldPrimitive.Root>
);

export { NumberInput, type NumberInputProps };
