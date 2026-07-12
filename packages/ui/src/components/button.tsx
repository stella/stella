"use client";

import type * as React from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { VariantProps } from "class-variance-authority";
import { LoaderIcon } from "lucide-react";

import { buttonVariants } from "@stll/ui/components/button-variants";
import { renderTooltipTrigger } from "@stll/ui/components/tooltip-trigger-helper";
import { cn } from "@stll/ui/lib/utils";

type ButtonProps = {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
  tooltip?: React.ReactNode;
} & useRender.ComponentProps<"button">;

function Button({
  className,
  variant,
  size,
  render,
  loading,
  children,
  disabled,
  tooltip,
  ...props
}: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";

  const defaultProps = {
    children: loading ? (
      <>
        <LoaderIcon className="animate-spin" />
        {children}
      </>
    ) : (
      children
    ),
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    disabled: loading || disabled,
    type: typeValue,
  };

  const button = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });

  return renderTooltipTrigger({
    tooltip: tooltip ?? props["aria-label"] ?? props.title,
    trigger: button,
  });
}

export { Button };
