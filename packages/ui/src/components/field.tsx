"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";

import { cn } from "../lib/utils";

const Field = ({ className, ...props }: FieldPrimitive.Root.Props) => (
  <FieldPrimitive.Root
    className={cn("flex flex-col items-start gap-2", className)}
    data-slot="field"
    {...props}
  />
);

const FieldLabel = ({ className, ...props }: FieldPrimitive.Label.Props) => (
  <FieldPrimitive.Label
    className={cn(
      "text-foreground inline-flex items-center gap-2 text-base/4.5 font-medium sm:text-sm/4",
      className,
    )}
    data-slot="field-label"
    {...props}
  />
);

const FieldItem = ({ className, ...props }: FieldPrimitive.Item.Props) => (
  <FieldPrimitive.Item
    className={cn("flex", className)}
    data-slot="field-item"
    {...props}
  />
);

const FieldDescription = ({
  className,
  ...props
}: FieldPrimitive.Description.Props) => (
  <FieldPrimitive.Description
    className={cn("text-muted-foreground text-xs", className)}
    data-slot="field-description"
    {...props}
  />
);

const FieldError = ({ className, ...props }: FieldPrimitive.Error.Props) => (
  <FieldPrimitive.Error
    className={cn("text-destructive-foreground text-xs", className)}
    data-slot="field-error"
    {...props}
  />
);

const FieldControl = FieldPrimitive.Control;
const FieldValidity = FieldPrimitive.Validity;

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldControl,
  FieldItem,
  FieldValidity,
};
