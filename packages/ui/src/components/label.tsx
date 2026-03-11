"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "@stella/ui/lib/utils";

function Label({
  className,
  render,
  ...props
}: useRender.ComponentProps<"label">) {
  const defaultProps = {
    className: cn(
      "text-foreground inline-flex items-center gap-2 text-base/4.5 font-medium sm:text-sm/4",
      className,
    ),
    "data-slot": "label",
  };

  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">(defaultProps, props),
    render,
  });
}

export { Label };
