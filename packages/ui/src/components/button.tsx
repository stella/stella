"use client";

import type * as React from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderIcon } from "lucide-react";

import {
  BUTTON_DISPOSITION,
  blockDisabledActivation,
  blockDisabledKeyActivation,
  resolveButtonDisposition,
} from "../lib/button-disposition";
import { MENU_ROW_CLASS_NAME } from "../lib/menu-row";
import { cn } from "../lib/utils";
import { renderTooltipTrigger } from "./tooltip-trigger-helper";

/**
 * Disabled styling for a button that is only `aria-disabled`.
 *
 * The `disabled:` utilities below are CSS `:disabled`, which cannot match an
 * element that carries no native `disabled` attribute, and `pointer-events-none`
 * is deliberately not repeated: that rule is the reason a disabled button's
 * tooltip can never open. Matches the treatment `disabled:opacity-64` gives, and
 * swaps the cursor so the control still reads as unavailable on hover.
 */
const buttonAccessibleDisabledClass = "cursor-not-allowed opacity-64";

const buttonVariants = cva(
  "focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border text-base font-medium whitespace-nowrap transition-shadow outline-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] focus-visible:ring-2 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-64 sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        // Pill chip beside a composer: pinned to the composer's round
        // controls (28px at every breakpoint) so a chip row and the control
        // row below it share one scale. Text stays `text-xs` at every
        // breakpoint for the same reason.
        chip: "h-7 gap-1.5 rounded-full px-2.5 text-xs before:rounded-full sm:text-xs",
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 rounded-md before:rounded-[calc(var(--radius-md)-1px)] sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        // One row of a menu list. The metric is shared with `CommandItem`; the
        // rest undoes the base button's centred content and its icon inset, so
        // a button row and a command row read as the same box.
        row: `${MENU_ROW_CLASS_NAME} [&_svg]:mx-0`,
        // Small controls read in small type; `SelectTrigger` and `Input`
        // share the height, so a toolbar of `sm` controls shares one scale.
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] text-sm sm:h-7 sm:text-xs",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-sm before:rounded-[calc(var(--radius-md)-1px)] sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground shadow-primary/24 [:hover,[data-pressed]]:bg-primary/90 shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
        destructive:
          "border-destructive/32 bg-destructive/10 text-destructive-foreground shadow-destructive/8 [:hover,[data-pressed]]:border-destructive/40 [:hover,[data-pressed]]:bg-destructive/14 [:active,[data-pressed]]:bg-destructive/18 shadow-xs not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] [:disabled,:active,[data-pressed]]:shadow-none",
        "destructive-outline":
          "border-input bg-popover text-destructive-foreground dark:bg-input/32 [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4 shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        "destructive-ghost":
          "text-destructive data-pressed:bg-destructive/10 [:hover,[data-pressed]]:bg-destructive/10 border-transparent",
        ghost:
          "text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent border-transparent",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        // Quiet action: muted until hovered, then the ghost treatment.
        muted:
          "text-muted-foreground data-pressed:bg-accent data-pressed:text-foreground [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground border-transparent",
        outline:
          "border-input bg-popover text-foreground dark:bg-input/32 [:hover,[data-pressed]]:bg-accent/50 dark:[:hover,[data-pressed]]:bg-input/64 shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        secondary:
          "bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90 border-transparent",
      },
    },
  },
);

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
        <LoaderIcon className="animate-spin" data-slot="button-loader" />
        {children}
      </>
    ) : (
      children
    ),
    className: cn(
      buttonVariants({ className, size, variant }),
      // While loading, the loader is the button's only icon: a caller's own
      // leading icon would otherwise sit beside it as a second spinner.
      loading && "[&_svg:not([data-slot=button-loader])]:hidden",
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
  });
}

export { Button, buttonAccessibleDisabledClass, buttonVariants };
