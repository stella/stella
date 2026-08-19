"use client";

import type * as React from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { VariantProps } from "class-variance-authority";
import { LoaderIcon } from "lucide-react";

import {
  BUTTON_DISPOSITION,
  blockDisabledActivation,
  blockDisabledKeyActivation,
  resolveButtonDisposition,
} from "../lib/button-disposition";
import type { OverlayLayer } from "../lib/overlay-layer";
import { cn } from "../lib/utils";
import {
  buttonAccessibleDisabledClass,
  buttonVariants,
} from "./button-variants";
import { renderTooltipTrigger } from "./tooltip-trigger-helper";

type ButtonProps = {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
  tooltip?: React.ReactNode;
  /**
   * Overlay band for the tooltip popup. Needed when the button sits in floating
   * chrome whose own band would otherwise paint over the popup.
   */
  tooltipLayer?: OverlayLayer | undefined;
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
  tooltipLayer,
  ...props
}: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";

  // Same value `renderTooltipTrigger` mounts below, so the disposition and the
  // popup cannot disagree about whether this button has a tooltip.
  const tooltipContent = tooltip ?? props["aria-label"] ?? props.title;
  const disposition = resolveButtonDisposition({
    disabled,
    loading,
    tooltip: tooltipContent,
  });
  const isAccessibleDisabled =
    disposition === BUTTON_DISPOSITION.accessibleDisabled;

  const defaultProps = {
    children: loading ? (
      <>
        <LoaderIcon className="animate-spin" />
        {children}
      </>
    ) : (
      children
    ),
    className: cn(
      buttonVariants({ className, size, variant }),
      isAccessibleDisabled && buttonAccessibleDisabledClass,
    ),
    "data-slot": "button",
    ...(isAccessibleDisabled
      ? { "aria-disabled": true, "data-disabled": "", tabIndex: 0 }
      : { disabled: disposition === BUTTON_DISPOSITION.nativeDisabled }),
    type: typeValue,
  };

  // The blockers are merged last so they run first and can stop the caller's
  // own handlers via `preventBaseUIHandler`; without them an `aria-disabled`
  // button would still click, still submit its form, and still fire onKeyDown.
  const button = useRender({
    defaultTagName: "button",
    props: isAccessibleDisabled
      ? mergeProps<"button">(defaultProps, props, {
          onClick: blockDisabledActivation,
          onKeyDown: blockDisabledKeyActivation,
          onKeyUp: blockDisabledKeyActivation,
          onMouseDown: blockDisabledActivation,
          onPointerDown: blockDisabledActivation,
        })
      : mergeProps<"button">(defaultProps, props),
    render,
  });

  return renderTooltipTrigger({
    tooltip: tooltipContent,
    trigger: button,
    ...(tooltipLayer === undefined ? {} : { layer: tooltipLayer }),
  });
}

export { Button };
