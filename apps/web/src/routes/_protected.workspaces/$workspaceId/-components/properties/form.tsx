import type { ComponentProps } from "react";

import { Field, FieldError } from "@stll/ui/components/field";
import { cn } from "@stll/ui/lib/utils";

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
type TextFieldHandle = {
  name: string;
  state: { value: string };
  handleChange: (value: string) => void;
  handleBlur: () => void;
};

type PropertyTextInputProps = {
  field: TextFieldHandle;
  placeholder: string;
};

export const PropertyTextInput = ({
  field,
  placeholder,
}: PropertyTextInputProps) => (
  <PropertyFormField name={field.name}>
    <input
      autoComplete="off"
      className="group-data-invalid:border-destructive/36 placeholder:text-foreground-placeholder w-full rounded-md px-1.5 py-1 text-sm font-semibold group-data-invalid:border focus-visible:outline-none"
      data-1p-ignore
      onBlur={field.handleBlur}
      onChange={(e) => field.handleChange(e.target.value)}
      placeholder={placeholder}
      type="text"
      value={field.state.value}
    />
    <FieldError />
  </PropertyFormField>
);
