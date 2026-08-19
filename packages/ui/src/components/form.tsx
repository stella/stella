"use client";

import { Form as FormPrimitive } from "@base-ui/react/form";

import { cn } from "../lib/utils";

const Form = ({ className, ...props }: FormPrimitive.Props) => (
  <FormPrimitive
    className={cn("flex w-full flex-col gap-4", className)}
    data-slot="form"
    {...props}
  />
);

export { Form };
