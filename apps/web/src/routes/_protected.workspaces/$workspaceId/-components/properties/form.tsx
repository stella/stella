import type { ComponentProps } from "react";

import type { AnyFieldApi } from "@tanstack/react-form";

import { Field, FieldError } from "@stella/ui/components/field";
import { cn } from "@stella/ui/lib/utils";

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
// TODO: FIXME — replace AnyFieldApi with a properly typed FieldApi
type PropertyTextInputProps = {
  field: AnyFieldApi;
  placeholder: string;
};

export const PropertyTextInput = ({
  field,
  placeholder,
}: PropertyTextInputProps) => (
  // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
  <PropertyFormField name={field.name}>
    <input
      autoComplete="off"
      className="group-data-invalid:border-destructive/36 placeholder:text-muted-foreground/72 w-full rounded-md px-1.5 py-1 text-sm font-semibold group-data-invalid:border focus-visible:outline-none"
      data-1p-ignore
      onBlur={field.handleBlur}
      onChange={(e) => field.handleChange(e.target.value)}
      placeholder={placeholder}
      type="text"
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      value={field.state.value}
    />
    <FieldError />
  </PropertyFormField>
);
