"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { panic } from "better-result";
import { cva, type VariantProps } from "class-variance-authority";

import {
  blockDisabledActivation,
  blockDisabledKeyActivation,
  BUTTON_DISPOSITION,
  resolveButtonDisposition,
} from "../lib/button-disposition";
import { MENU_ROW_CLASS_NAME } from "../lib/menu-row";
import { cn } from "../lib/utils";
import { Loader } from "./loader";
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

/**
 * Press feedback: the button gives slightly under the pointer.
 *
 * Applied by `Button` only while it can act, so a disabled or loading button
 * never appears to respond. `scale` is its own property in Tailwind v4, so it
 * composes with a caller's `translate` (a vertically centred icon button) and
 * the transition names only the transform family. Menu rows and link-styled
 * buttons keep the treatment of their surface instead.
 */
const buttonPressClass =
  "motion-safe:transition-transform motion-safe:duration-150 ease-out motion-safe:active:scale-[0.98]";

const BUTTON_DEFAULT_SIZE = "default";

const buttonVariants = cva(
  "focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border text-base font-medium whitespace-nowrap outline-none select-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] focus-visible:ring-2 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-64 sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
  {
    // An inline button is a word in a sentence: a hover fill behind it would
    // read as a box the line does not have. The quiet variants keep their
    // text treatment and drop the fill.
    compoundVariants: [
      {
        className: "[:hover:not([data-pressed])]:bg-transparent",
        size: "inline",
        variant: [
          "destructive-ghost",
          "ghost",
          "link",
          "muted",
          "muted-destructive",
        ],
      },
      // A link set in running text is underlined like the links beside it,
      // not only under the pointer.
      {
        className: "underline",
        size: "inline",
        variant: "link",
      },
    ],
    defaultVariants: {
      size: BUTTON_DEFAULT_SIZE,
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
        // The smallest square: a glyph-sized action inside a dense row (a
        // margin note's edit and delete, a tree's disclosure chevron). Its
        // touch target still grows to 44px under a coarse pointer.
        "icon-2xs":
          "size-5 rounded-md before:rounded-[calc(var(--radius-md)-1px)] sm:size-4 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3",
        "icon-xs":
          "size-7 rounded-md before:rounded-[calc(var(--radius-md)-1px)] sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        // A button that sits in a line of text: a "show more", a citation, an
        // inline edit. It draws no box of its own (no height, padding or type
        // size), takes the font of the line around it and wraps with it, so
        // swapping a word for an action leaves the line as it was. Its
        // variant still owns colour, focus and the selected treatment; see
        // compoundVariants for the hover fill it does not paint.
        // It is an inline box, not a flex one, so a long label breaks across
        // lines with the sentence, and its text stays selectable so a
        // citation or a reference can be copied with the passage around it.
        inline:
          "inline h-auto rounded-sm border-0 p-0 text-start text-[length:inherit] leading-[inherit] font-normal whitespace-normal select-text before:rounded-[calc(var(--radius-sm)-1px)] sm:text-[length:inherit] [&_svg]:mx-0 [&_svg]:inline [&_svg]:align-[-0.125em] [&_svg:not(:last-child)]:me-1",
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
          "border-primary bg-primary text-primary-foreground shadow-primary/24 data-pressed:bg-primary/80 [:hover:not([data-pressed])]:bg-primary/90 shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
        destructive:
          "border-destructive/32 bg-destructive/10 text-destructive-foreground shadow-destructive/8 data-pressed:border-destructive/56 data-pressed:bg-destructive/20 [:hover:not([data-pressed])]:border-destructive/40 [:hover:not([data-pressed])]:bg-destructive/14 active:bg-destructive/18 shadow-xs not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] [:disabled,:active,[data-pressed]]:shadow-none",
        "destructive-outline":
          "border-input bg-popover text-destructive-foreground dark:bg-input/32 data-pressed:border-destructive/56 data-pressed:bg-destructive/8 [:hover:not([data-pressed])]:border-destructive/32 [:hover:not([data-pressed])]:bg-destructive/4 shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        "destructive-ghost":
          "text-destructive data-pressed:bg-destructive/14 data-pressed:inset-ring-destructive/32 [:hover:not([data-pressed])]:bg-destructive/10 border-transparent data-pressed:inset-ring",
        ghost:
          "text-foreground data-pressed:bg-accent data-pressed:inset-ring-input [:hover:not([data-pressed])]:bg-accent border-transparent data-pressed:shadow-xs/5 data-pressed:inset-ring",
        link: "border-transparent underline-offset-4 data-pressed:underline data-pressed:decoration-2 [:hover:not([data-pressed])]:underline",
        // Quiet until hovered, then destructive: a delete beside quiet actions.
        "muted-destructive":
          "text-muted-foreground data-pressed:bg-destructive/14 data-pressed:text-destructive data-pressed:inset-ring-destructive/32 [:hover:not([data-pressed])]:bg-destructive/10 [:hover:not([data-pressed])]:text-destructive border-transparent data-pressed:inset-ring",
        // Quiet action: muted until hovered, then the ghost treatment.
        muted:
          "text-muted-foreground data-pressed:bg-accent data-pressed:text-foreground data-pressed:inset-ring-input [:hover:not([data-pressed])]:bg-accent [:hover:not([data-pressed])]:text-foreground border-transparent data-pressed:shadow-xs/5 data-pressed:inset-ring",
        outline:
          "border-input bg-popover text-foreground dark:bg-input/32 data-pressed:border-primary/48 data-pressed:bg-accent dark:data-pressed:bg-input/64 [:hover:not([data-pressed])]:bg-accent/50 dark:[:hover:not([data-pressed])]:bg-input/64 shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        secondary:
          "bg-secondary text-secondary-foreground data-pressed:bg-background data-pressed:inset-ring-input active:bg-secondary/80 [:hover:not([data-pressed])]:bg-secondary/90 border-transparent data-pressed:shadow-xs/5 data-pressed:inset-ring",
      },
    },
  },
);

type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

/**
 * `plain`: a click target whose look is its content (a card, a thumbnail, a
 * cell, a passage). It bypasses `buttonVariants` and its box, border, type
 * and press motion instead of undoing them class by class, and keeps
 * everything else a `Button` owns: the disabled disposition, the tooltip, the
 * focus ring. It lays out like a native button (`inline-block`, content
 * flowing from the start), so a card's children stack as they would in a
 * `div`; `className` places it (`w-full`, `block`). `shape` gives it the
 * outline its focus ring follows. Like a native button it does not dim when
 * disabled: the content says it is unavailable. A `size` does not apply to it.
 */
const BUTTON_PLAIN_CLASS =
  "focus-visible:ring-ring focus-visible:ring-offset-background inline-block cursor-pointer text-start outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-default";

/**
 * The outline a plain button's focus ring follows, matching its content:
 * `box` for a card, row or block of text (the container radius), `round` for
 * an avatar, a dot or a pill.
 */
const BUTTON_PLAIN_SHAPE_CLASS = {
  box: "rounded-lg",
  round: "rounded-full",
} as const;

type ButtonPlainShape = keyof typeof BUTTON_PLAIN_SHAPE_CLASS;

type ButtonVariant =
  NonNullable<VariantProps<typeof buttonVariants>["variant"]> | "plain";

/**
 * Where the focus ring is drawn. `outside` (the default) rings the box with a
 * gap; `inside` draws it within the box, for a target that fills a clipping
 * container (an `overflow-hidden` card, a table cell, a thumbnail grid) where
 * an outside ring would be cut off.
 */
type ButtonFocusRing = "outside" | "inside";

const BUTTON_FOCUS_RING_INSIDE_CLASS =
  "focus-visible:ring-inset focus-visible:ring-offset-0";

/** What a button's box holds: a glyph alone, or a visible label. */
const BUTTON_CONTENT = {
  icon: "icon",
  text: "text",
} as const;

/**
 * An icon size is a square that fits a glyph and no label, so the button shows
 * no text, and its accessible name doubles as its tooltip. A text size shows
 * its own label and gets a tooltip only from an explicit `tooltip`: an implicit
 * one would repeat or contradict the label, and because a tooltip opens on
 * focus, it would take the first Escape from a popover or dialog that focuses
 * the button.
 *
 * Icon sizes are exactly the `icon`-prefixed ones; the type below enforces it,
 * because the `icon-button-requires-tooltip` lint rule reads the same prefix.
 */
const BUTTON_SIZE_CONTENT = {
  chip: BUTTON_CONTENT.text,
  default: BUTTON_CONTENT.text,
  icon: BUTTON_CONTENT.icon,
  "icon-lg": BUTTON_CONTENT.icon,
  "icon-sm": BUTTON_CONTENT.icon,
  "icon-xl": BUTTON_CONTENT.icon,
  "icon-2xs": BUTTON_CONTENT.icon,
  "icon-xs": BUTTON_CONTENT.icon,
  inline: BUTTON_CONTENT.text,
  lg: BUTTON_CONTENT.text,
  row: BUTTON_CONTENT.text,
  sm: BUTTON_CONTENT.text,
  xl: BUTTON_CONTENT.text,
  xs: BUTTON_CONTENT.text,
} as const satisfies {
  [Size in ButtonSize]: Size extends `icon${string}`
    ? typeof BUTTON_CONTENT.icon
    : typeof BUTTON_CONTENT.text;
};

const implicitTooltip = (
  size: ButtonSize | null | undefined,
  accessibleName: string | undefined,
): string | undefined => {
  const content = BUTTON_SIZE_CONTENT[size ?? BUTTON_DEFAULT_SIZE];
  switch (content) {
    case BUTTON_CONTENT.icon:
      return accessibleName;
    case BUTTON_CONTENT.text:
      return undefined;
    default:
      content satisfies never;
      return panic(`Unhandled button content: ${String(content)}`);
  }
};

type ButtonProps = {
  variant?: ButtonVariant | null | undefined;
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
  icon?: ReactNode;
  tooltip?: ReactNode;
  /**
   * The current choice in a set (a picked option, the active filter tab, the
   * open item of a list): shows the variant's selected treatment, which is
   * distinct from its hover. The ARIA state stays the caller's
   * (`aria-pressed`, `aria-checked`, `aria-current` or `aria-selected`),
   * because which one is right depends on the widget the button is part of.
   * For a set of mutually exclusive options prefer `ToggleGroup`, which owns
   * that state.
   */
  selected?: boolean | undefined;
  focusRing?: ButtonFocusRing | undefined;
  /** `variant="plain"` only: the outline its focus ring follows. */
  shape?: ButtonPlainShape | undefined;
  "data-accessible-disabled"?: "";
} & useRender.ComponentProps<"button">;

function Button({
  className,
  variant: variantProp,
  size,
  render,
  loading,
  icon,
  children,
  disabled,
  tooltip,
  selected,
  focusRing = "outside",
  shape = "box",
  "data-accessible-disabled": accessibleDisabled,
  ...props
}: ButtonProps) {
  // An inline action with no variant reads as a link in its sentence; the
  // filled default would paint a box the line does not have.
  const variant = variantProp ?? (size === "inline" ? "link" : undefined);
  const typeValue: ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";
  // Same value `renderTooltipTrigger` mounts below, so the disposition and the
  // popup cannot disagree about whether this button has a tooltip.
  const tooltipContent =
    tooltip ?? implicitTooltip(size, props["aria-label"] ?? props.title);
  const disposition = resolveButtonDisposition({
    disabled,
    loading,
    tooltip: tooltipContent,
  });
  const isAccessibleDisabled =
    disposition === BUTTON_DISPOSITION.accessibleDisabled;
  const isActivationPreservingDisabled = accessibleDisabled !== undefined;

  const defaultProps = {
    children: buttonContent({ children, icon, loading }),
    className: cn(
      variant === "plain"
        ? cn(BUTTON_PLAIN_CLASS, BUTTON_PLAIN_SHAPE_CLASS[shape], className)
        : cn(
            disposition === BUTTON_DISPOSITION.enabled &&
              !isActivationPreservingDisabled &&
              size !== "row" &&
              size !== "inline" &&
              variant !== "link" &&
              buttonPressClass,
            buttonVariants({ className, size, variant }),
          ),
      focusRing === "inside" && BUTTON_FOCUS_RING_INSIDE_CLASS,
      (isAccessibleDisabled || isActivationPreservingDisabled) &&
        buttonAccessibleDisabledClass,
    ),
    "data-slot": "button",
    "data-pressed": selected === true ? "" : undefined,
    "aria-busy": loading || undefined,
    ...(isAccessibleDisabled || isActivationPreservingDisabled
      ? { "aria-disabled": true, "data-disabled": "", tabIndex: 0 }
      : { disabled: disposition === BUTTON_DISPOSITION.nativeDisabled }),
    "data-accessible-disabled": accessibleDisabled,
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

/**
 * What the button shows. Loading never changes its width: with an `icon`,
 * the loader takes the icon's place; without one, the label stays in place
 * but transparent (still the accessible name) and the loader sits over its
 * centre, so a row of buttons does not shift when one starts saving.
 */
function buttonContent({
  children,
  icon,
  loading,
}: {
  children: ReactNode;
  icon: ReactNode;
  loading: boolean | undefined;
}): ReactNode {
  if (!loading) {
    return (
      <>
        {icon}
        {children}
      </>
    );
  }
  const hasIcon = icon !== undefined && icon !== null && icon !== false;
  const loader = (
    <Loader
      animation="none"
      className={cn(
        "[transition:opacity_150ms_ease-out,scale_320ms_var(--ease-spring)] motion-reduce:transition-none starting:scale-50 starting:opacity-0",
        !hasIcon && "absolute inset-0 m-auto",
      )}
      data-slot="button-loader"
      size="sm"
      variant="decorative"
    />
  );
  if (hasIcon) {
    return (
      <>
        {loader}
        {children}
      </>
    );
  }
  return (
    <>
      <span
        className="inline-flex items-center gap-[inherit] opacity-0"
        data-slot="button-label"
      >
        {children}
      </span>
      {loader}
    </>
  );
}

export type {
  ButtonFocusRing,
  ButtonPlainShape,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
};
export {
  Button,
  BUTTON_CONTENT,
  BUTTON_SIZE_CONTENT,
  buttonAccessibleDisabledClass,
  buttonVariants,
};
