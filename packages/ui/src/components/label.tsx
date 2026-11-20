"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "../lib/utils";
import { LABEL_VARIANT_CLASS_NAME, type LabelVariant } from "./label-classes";

/** A caption for a control; the variants are described in ./label-classes.ts. */
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
