"use client";

import {
  type ButtonHTMLAttributes,
  Fragment,
  isValidElement,
  type ReactNode,
} from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { panic } from "better-result";
import { cva } from "class-variance-authority";

import {
  blockDisabledActivation,
  blockDisabledKeyActivation,
  BUTTON_DISPOSITION,
  resolveButtonDisposition,
} from "../lib/button-disposition";
import { rendersNothing } from "../lib/renders-nothing";
import { cn } from "../lib/utils";
import {
  BUTTON_BASE_CLASS,
  BUTTON_DEFAULT_SIZE,
  BUTTON_LAYOUT_CLASS_NAMES,
  BUTTON_SIZE_CLASS_NAMES,
  BUTTON_VARIANT_CLASS_NAMES,
} from "./button-classes";
import {
  BUTTON_PLAIN_VARIANT,
  type ButtonContract,
  type ButtonSize,
  type ButtonVariant,
} from "./button.shared";
import { Loader } from "./loader";
import { renderTooltipTrigger } from "./tooltip-trigger-helper";
import { TruncatedText } from "./truncated-text";

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

const buttonVariants = cva(BUTTON_BASE_CLASS, {
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
    size: BUTTON_SIZE_CLASS_NAMES,
    layout: BUTTON_LAYOUT_CLASS_NAMES,
    variant: BUTTON_VARIANT_CLASS_NAMES,
  },
});

/**
 * `plain` (./button.shared.ts) on the web. It bypasses `buttonVariants` and
 * its box, border, type and press motion instead of undoing them class by
 * class, and keeps the disabled disposition, the tooltip and the focus ring.
 * It lays out like a native button (`inline-block`, content flowing from the
 * start), so a card's children stack as they would in a `div`; `className`
 * places it (`w-full`, `block`). `shape` gives it the outline its focus ring
 * follows. Like a native button it does not dim when disabled: the content
 * says it is unavailable.
 *
 * Selected, it draws the inset edge the other variants draw, as an outline
 * inside the box: an outline paints above the content, so a card's own
 * surface cannot cover it the way it would cover an inset shadow.
 */
const BUTTON_PLAIN_CLASS =
  "focus-visible:ring-ring focus-visible:ring-offset-background data-pressed:outline-primary/48 relative inline-block max-w-full cursor-pointer text-start outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-default data-pressed:outline-2 data-pressed:-outline-offset-2 data-pressed:outline-solid";

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
  "icon-round": BUTTON_CONTENT.icon,
  "icon-sm": BUTTON_CONTENT.icon,
  "icon-xl": BUTTON_CONTENT.icon,
  "icon-2xs": BUTTON_CONTENT.icon,
  "icon-xs": BUTTON_CONTENT.icon,
  inline: BUTTON_CONTENT.text,
  "inspector-row": BUTTON_CONTENT.text,
  lg: BUTTON_CONTENT.text,
  row: BUTTON_CONTENT.text,
  sm: BUTTON_CONTENT.text,
  touch: BUTTON_CONTENT.text,
  xl: BUTTON_CONTENT.text,
  xs: BUTTON_CONTENT.text,
} as const satisfies {
  [Size in ButtonSize]: Size extends `icon${string}`
    ? typeof BUTTON_CONTENT.icon
    : typeof BUTTON_CONTENT.text;
};

/**
 * A button never grows past its container (`max-w-full` on every variant).
 * A one-line text label is cut to fit with an ellipsis; the button's
 * accessible name keeps the whole text, and `tooltip` can show it. The label
 * is a `TruncatedText` without its own hint: a tooltip root in every button's
 * label would cost every screen with many buttons. `layout="wrap"` lets a
 * label take several lines instead. An inline button is a word in a sentence
 * and a plain button lays out its own content, so neither has a one-line
 * label to cut.
 */

const cutsLabel = ({
  layout,
  size,
  variant,
}: {
  layout: keyof typeof BUTTON_LAYOUT_CLASS_NAMES | undefined;
  size: ButtonSize | null | undefined;
  variant: ButtonVariant | null | undefined;
}): boolean =>
  layout === undefined &&
  variant !== BUTTON_PLAIN_VARIANT &&
  variant !== "link" &&
  size !== "inline" &&
  BUTTON_SIZE_CONTENT[size ?? BUTTON_DEFAULT_SIZE] === BUTTON_CONTENT.text;

/**
 * Each run of adjacent text among the children, cut to the button's width.
 * Adjacent text (`Save {count} files`) stays one run, as it is one flex item
 * in the button's box; children React renders as nothing (`null`, `false`)
 * do not split it. Every other child keeps its place in a fragment keyed by
 * its own key, or by its position when it has none, so keyed children keep
 * their state when they move.
 */
const containedLabel = (children: ReactNode): ReactNode => {
  const items: readonly ReactNode[] = Array.isArray(children)
    ? children
    : [children];
  const parts: ReactNode[] = [];
  let run: (string | number)[] = [];
  const closeRun = () => {
    if (run.length > 0) {
      parts.push(
        <TruncatedText
          data-slot="button-label"
          hint={false}
          key={`label:${String(parts.length)}`}
        >
          {run}
        </TruncatedText>,
      );
      run = [];
    }
  };
  for (const child of items) {
    if (child === null || child === undefined || typeof child === "boolean") {
      continue;
    }
    if (typeof child === "string" || typeof child === "number") {
      run.push(child);
      continue;
    }
    closeRun();
    const key =
      isValidElement(child) && child.key !== null
        ? `key:${child.key}`
        : `part:${String(parts.length)}`;
    parts.push(<Fragment key={key}>{child}</Fragment>);
  }
  closeRun();
  return parts;
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

/**
 * `selected` (./button.shared.ts) sets `data-pressed`, which every variant
 * paints. The ARIA state (`aria-pressed`, `aria-checked`, `aria-current` or
 * `aria-selected`) stays the caller's. For a set of mutually exclusive
 * options prefer `ToggleGroup`, which owns that state.
 */
type ButtonProps = Omit<ButtonContract, "children" | "disabled"> & {
  layout?: keyof typeof BUTTON_LAYOUT_CLASS_NAMES;
  tooltip?: ReactNode;
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
  layout,
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
    children: buttonContent({
      icon,
      label: cutsLabel({ layout, size, variant })
        ? containedLabel(children)
        : children,
      loading,
    }),
    className: cn(
      variant === BUTTON_PLAIN_VARIANT
        ? cn(BUTTON_PLAIN_CLASS, BUTTON_PLAIN_SHAPE_CLASS[shape], className)
        : cn(
            disposition === BUTTON_DISPOSITION.enabled &&
              !isActivationPreservingDisabled &&
              size !== "row" &&
              size !== "inline" &&
              variant !== "link" &&
              buttonPressClass,
            buttonVariants({ className, size, variant, layout }),
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
 * the loader takes the icon's place; without one, the label (already cut to
 * the button's width where it is cut) stays in place but transparent (still
 * the accessible name) and the loader sits over its centre, so a row of
 * buttons does not shift when one starts saving.
 */
function buttonContent({
  icon,
  label,
  loading,
}: {
  icon: ReactNode;
  label: ReactNode;
  loading: boolean | undefined;
}): ReactNode {
  if (!loading) {
    return (
      <>
        {icon}
        {label}
      </>
    );
  }
  const hasIcon = !rendersNothing(icon);
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
        {label}
      </>
    );
  }
  return (
    <>
      <span
        className="inline-flex min-w-0 items-center gap-[inherit] opacity-0"
        data-slot="button-loading-label"
      >
        {label}
      </span>
      {loader}
    </>
  );
}

/**
 * The run is the visible target, ringed while its button has keyboard focus
 * (per line, so a wrapped run rings each line).
 */
const BUTTON_TEXT_RUN_CLASS =
  "has-focus-visible:ring-ring cursor-pointer rounded-xs box-decoration-clone select-text has-focus-visible:ring-2 has-disabled:cursor-not-allowed has-disabled:opacity-64";

/**
 * How a run shows it can be pressed: underlined like a link, or `plain`, by
 * what it holds (a claim's text mark, which draws its own line), as a plain
 * Button's look is its content.
 */
const BUTTON_TEXT_RUN_VARIANT_CLASS = {
  link: "underline underline-offset-2 hover:decoration-2",
  plain: "",
} as const;

type ButtonTextRunVariant = keyof typeof BUTTON_TEXT_RUN_VARIANT_CLASS;

// Visually hidden but focusable: the run, not this box, shows the focus.
const BUTTON_TEXT_RUN_TARGET_CLASS =
  "absolute size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]";

/**
 * A run with no box can anchor no tooltip or popup, and carries no variant,
 * size or icon: its text is its look.
 */
type ButtonTextRunProps = Omit<
  ButtonProps,
  | "children"
  | "className"
  | "focusRing"
  | "icon"
  | "loading"
  | "render"
  | "selected"
  | "shape"
  | "size"
  | "tooltip"
  | "variant"
> & {
  children: ReactNode;
  className?: string | undefined;
  /** `link` unless the run holds a text mark that draws its own line. */
  variant?: ButtonTextRunVariant | undefined;
};

/**
 * A long run of prose that acts as one button: a citation or a
 * cross-reference in reader text. A <button> is an atomic box even at
 * `display: inline`, so its label cannot break across the paragraph's lines;
 * here the text sits in a native <label>, an inline box that wraps and copies
 * with the prose, and the label forwards a press anywhere on the run to the
 * <button> it holds, which takes its accessible name from the label. Use
 * `Button size="inline"` for a short action.
 */
const ButtonTextRun = ({
  children,
  className,
  disabled,
  variant = "link",
  ...props
}: ButtonTextRunProps) => (
  <label
    className={cn(
      BUTTON_TEXT_RUN_CLASS,
      BUTTON_TEXT_RUN_VARIANT_CLASS[variant],
      className,
    )}
    data-slot="button-text-run"
  >
    {/* Pinned after the spread: a value typed wider than the props could
        still carry a box, a tooltip or an icon the run cannot show. */}
    <Button
      {...props}
      className={BUTTON_TEXT_RUN_TARGET_CLASS}
      disabled={disabled}
      focusRing="outside"
      icon={undefined}
      loading={false}
      render={undefined}
      selected={false}
      shape="box"
      size={undefined}
      tooltip={undefined}
      variant={BUTTON_PLAIN_VARIANT}
    />
    {children}
  </label>
);

export type {
  ButtonFocusRing,
  ButtonPlainShape,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
};
export {
  Button,
  ButtonTextRun,
  BUTTON_CONTENT,
  BUTTON_SIZE_CONTENT,
  buttonAccessibleDisabledClass,
  buttonVariants,
};
