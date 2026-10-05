"use client";

import { Form as FormPrimitive } from "@base-ui/react/form";

import { cn } from "../lib/utils";
import { DialogFormState } from "./dialog-form-state";

const Form = ({
  className,
  dirty = false,
  onDiscard,
  children,
  ...props
}: FormPrimitive.Props & {
  dirty?: boolean;
  onDiscard?: (() => void) | undefined;
}) => (
  <FormPrimitive
    className={cn("flex w-full flex-col gap-4", className)}
    data-slot="form"
    {...props}
  >
    <DialogFormState dirty={dirty} onDiscard={onDiscard} />
    {children}
  </FormPrimitive>
);

export { Form };
