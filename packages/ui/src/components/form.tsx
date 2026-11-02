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

/**
 * Errors a server returned for the last submit, keyed by each `Field`'s
 * `name`: one message or several.
 */
type FormErrors = NonNullable<FormPrimitive.Props["errors"]>;

type FormProps = FormPrimitive.Props &
  VariantProps<typeof formVariants> & {
    dirty?: boolean;
    onDiscard?: (() => void) | undefined;
  };

/**
 * A form whose fields report their own errors.
 *
 * Validation, in the order a reader meets it:
 *
 * - **In the browser.** A `Field` reads its control's constraints
 *   (`required`, `type`, `pattern`, `min`/`max`, a `validate` function) and
 *   shows a `FieldError` for the ones that fail. `validationMode` stays
 *   Base UI's `onSubmit`: nothing is flagged while a person tabs through an
 *   empty form, the first submit marks every invalid field at once, and from
 *   then on each field re-validates as it changes. `onBlur` would flag a
 *   required field the moment focus passes it, before anyone tried to submit;
 *   pass it only where checking a value as soon as it is left is the point
 *   (an availability check, a long identifier).
 * - **From the server.** Pass what the server rejected as `errors`, keyed by
 *   field `name` (`{ email: "Already invited" }`). The field turns invalid,
 *   its control gets `aria-invalid`, and its `FieldError` shows the message.
 *   Base UI drops a field's server error as soon as its value changes, so a
 *   correction clears the message without a round trip. Keep the errors in
 *   state and replace them on the next submit.
 *
 * In a `FieldError`, leave `match` unset to show whichever error the field
 * has, the server's included; `match="valueMissing"` (or another validity
 * key) words one constraint in the product's voice; `match` set to `true`
 * hands visibility to the caller.
 *
 * `dirty` and `onDiscard` register the form with an enclosing `Dialog`'s
 * unsaved-changes guard.
 */
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
export type { FormErrors, FormProps };
