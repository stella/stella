"use client";

import { Form as FormPrimitive } from "@base-ui/react/form";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";
import { DialogFormState } from "./dialog-form-state";

const formVariants = cva("flex w-full", {
  defaultVariants: {
    density: "default",
    layout: "stack",
  },
  variants: {
    // Space between the form's fields and its actions.
    density: {
      default: "gap-4",
      // Fields that belong together as one small group (a sign-in code step,
      // a card's single setting).
      snug: "gap-3",
      // A one-line form or a short stack inside a card or popover.
      compact: "gap-2",
    },
    layout: {
      // Fields stacked one above the other, actions last.
      stack: "flex-col",
      // One line: a field and its submit button side by side (add a term,
      // create a list).
      inline: "flex-row items-center",
    },
  },
});

type FormProps = FormPrimitive.Props &
  VariantProps<typeof formVariants> & {
    dirty?: boolean;
    onDiscard?: (() => void) | undefined;
  };

const Form = ({
  className,
  density,
  layout,
  dirty = false,
  onDiscard,
  children,
  ...props
}: FormProps) => (
  <FormPrimitive
    className={cn(formVariants({ density, layout }), className)}
    data-slot="form"
    {...props}
  >
    <DialogFormState dirty={dirty} onDiscard={onDiscard} />
    {children}
  </FormPrimitive>
);

export { Form, formVariants };
export type { FormProps };
