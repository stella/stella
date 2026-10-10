import type { ComponentProps } from "react";

import { Field } from "@stll/ui/field";
import { cn } from "@stll/ui/utils";

type PropertyFormFieldProps = ComponentProps<typeof Field>;

export const PropertyFormField = ({
  children,
  className,
  ...props
}: PropertyFormFieldProps) => (
  <Field className={cn("group gap-1 p-1", className)} {...props}>
    {children}
  </Field>
);
