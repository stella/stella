"use client";

import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";

import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { cn } from "../lib/utils";

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
  size = CONTROL_SIZE.default,
  ...props
}: NumberInputProps) => (
  <NumberFieldPrimitive.Root
    {...props}
    className={cn(
      "border-input bg-background text-foreground ring-ring/24 has-autofill:bg-foreground/4 has-focus-visible:border-ring has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 relative inline-flex w-full rounded-lg border text-base shadow-xs/5 transition-shadow not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:ring-[3px] has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none sm:text-sm dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
      className,
    )}
    data-size={size}
    data-slot="number-input-control"
    render={undefined}
  >
    <NumberFieldPrimitive.Input
      {...inputProps}
      className={cn(
        "placeholder:text-foreground-placeholder h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:h-7.5 sm:leading-7.5",
        NUMBER_INPUT_SIZE_CLASS_NAMES[size],
        inputClassName,
      )}
      data-slot="number-input"
    />
  </NumberFieldPrimitive.Root>
);

const NUMBER_INPUT_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]:
    "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
  [CONTROL_SIZE.default]: undefined,
  [CONTROL_SIZE.lg]: "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
} as const satisfies Record<ControlSize, string | undefined>;

export { NumberInput, type NumberInputProps };
