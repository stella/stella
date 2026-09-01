"use client";

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
    "className" | "defaultValue" | "id" | "onChange" | "type" | "value"
  >;
  size?: ControlSize;
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
        inputClassName,
      )}
      data-slot="number-input"
    />
  </NumberFieldPrimitive.Root>
);

export { NumberInput, type NumberInputProps };
