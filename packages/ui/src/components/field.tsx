"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";

import { cn } from "../lib/utils";
import {
  FIELD_CLASS_NAME,
  FIELD_DESCRIPTION_CLASS_NAME,
} from "./field-classes";
import { LABEL_VARIANT_CLASS_NAME } from "./label-classes";

const Field = ({ className, ...props }: FieldPrimitive.Root.Props) => (
  <FieldPrimitive.Root
    className={cn(FIELD_CLASS_NAME, className)}
    data-slot="field"
    {...props}
  />
);

const FieldLabel = ({ className, ...props }: FieldPrimitive.Label.Props) => (
  <FieldPrimitive.Label
    className={cn(LABEL_VARIANT_CLASS_NAME.default, className)}
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
    className={cn(FIELD_DESCRIPTION_CLASS_NAME, className)}
    data-slot="field-description"
    {...props}
  />
);

/**
 * The message for an invalid field. With no `match` it shows whatever error
 * the field has, including one the `Form` received in `errors` from the
 * server; with a validity key (`match="valueMissing"`) it shows only for that
 * constraint, so each rule can be worded on its own. See `Form`.
 */
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
