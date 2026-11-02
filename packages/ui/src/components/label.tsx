"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "../lib/utils";

/**
 * - `default`: the caption above or beside a control.
 * - `choice`: one row of a list of choices, wrapping its radio or checkbox so
 *   the whole row picks it; it highlights on hover and rings while the
 *   control inside has keyboard focus.
 * - `choice-card`: a bordered card wrapping its radio, for choices that carry
 *   a description; the chosen card takes the primary border.
 * - `muted`: a quiet caption in small type, for a filter bar or a dense side
 *   form where the controls, not their names, carry the eye.
 *
 * The choice variants dim and stop inviting a click while their control is
 * disabled.
 */
const LABEL_VARIANT_CLASS_NAME = {
  default:
    "text-foreground inline-flex items-center gap-2 text-base/4.5 font-medium sm:text-sm/4",
  choice:
    "hover:bg-muted/60 has-focus-visible:ring-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-sm has-focus-visible:ring-2 has-disabled:cursor-not-allowed has-disabled:opacity-64",
  "choice-card":
    "has-checked:border-primary has-checked:bg-muted/50 flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 has-disabled:cursor-not-allowed has-disabled:opacity-50",
  muted:
    "text-muted-foreground inline-flex items-center gap-2 text-xs/4 font-medium",
} as const;

type LabelVariant = keyof typeof LABEL_VARIANT_CLASS_NAME;

function Label({
  className,
  render,
  variant = "default",
  ...props
}: useRender.ComponentProps<"label"> & { variant?: LabelVariant }) {
  const defaultProps = {
    className: cn(LABEL_VARIANT_CLASS_NAME[variant], className),
    "data-slot": "label",
  };

  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">(defaultProps, props),
    render,
  });
}

export { Label, type LabelVariant };
