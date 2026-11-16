"use client";

import * as React from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { containedEventHandler } from "../hooks/use-contained-handler";
import { cn } from "../lib/utils";
import { Popover, PopoverPopup } from "./popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * Text that ends in an ellipsis when it does not fit, and shows the whole of
 * it only when it was actually cut: on hover or focus with a tooltip, and on
 * a tap with a popover, because touch has no hover.
 *
 * Nothing is measured until someone points at or focuses the text, so a long
 * list of these costs no layout reads while it renders or scrolls. The full
 * text stays in the DOM, so a screen reader always reads all of it; the hint
 * is for sighted readers only.
 *
 * The tap popover stays out of the way when the text sits inside a link,
 * button or other control: the tap belongs to that control.
 */
const TruncatedText = ({
  children,
  className,
  hint = true,
  lines = 1,
  render,
  side = "top",
  tooltip,
  ...props
}: TruncatedTextProps) => {
  const ref = React.useRef<HTMLElement>(null);
  const [surface, setSurface] = React.useState<TruncatedTextSurface | null>(
    null,
  );
  const content = tooltip ?? children;

  const handleTooltipOpenChange = (open: boolean) => {
    if (!open) {
      setSurface((current) => (current === "tooltip" ? null : current));
      return;
    }
    const element = ref.current;
    // A tap focuses the text before it clicks; the popover answers taps. A
    // tooltip around the text already answers the pointer, and two at once
    // cover each other.
    if (
      element === null ||
      LAST_POINTER_TYPE.get(element) === "touch" ||
      isInsideTooltipTrigger(element)
    ) {
      return;
    }
    if (isTextOverflowing(element)) {
      setSurface("tooltip");
    }
  };

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    const element = event.currentTarget;
    if (
      LAST_POINTER_TYPE.get(element) === "touch" &&
      !isInsideControl(element) &&
      isTextOverflowing(element)
    ) {
      setSurface("popover");
    }
  };

  const defaultProps = {
    children,
    className: cn(TRUNCATED_TEXT_LINES_CLASS[lines], className),
    "data-slot": "truncated-text",
  };

  const text = useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    ref,
    render,
  });

  if (!hint) {
    return text;
  }

  // The trigger merges its handlers into the text element, chaining any
  // handler the caller passed, and keeps the element's ref.
  return (
    <>
      <Tooltip
        onOpenChange={handleTooltipOpenChange}
        open={surface === "tooltip"}
      >
        <TooltipTrigger
          onClick={containedEventHandler(handleClick)}
          onPointerDown={containedEventHandler(recordPointerType)}
          onBlur={forgetPointerType}
          onPointerEnter={recordPointerType}
          render={text}
        />
        <TooltipPopup side={side}>{content}</TooltipPopup>
      </Tooltip>
      {surface === "popover" ? (
        <Popover
          onOpenChange={(open) => {
            if (!open) {
              setSurface(null);
            }
          }}
          open
        >
          <PopoverPopup anchor={ref} side={side} tooltipStyle>
            {content}
          </PopoverPopup>
        </Popover>
      ) : null}
    </>
  );
};

type TruncatedTextSurface = "tooltip" | "popover";

/**
 * How many lines the text may take before it is cut; `"none"` lets it take
 * as many as it needs, for text that is cut only in some states (collapsed,
 * compact) and shown whole in the others.
 */
type TruncatedTextLines = 1 | 2 | 3 | 4 | 5 | 6 | 8 | "none";

type TruncatedTextProps = useRender.ComponentProps<"span"> & {
  /**
   * Whether cut text shows its whole self on hover, focus or tap. Pass false
   * only where something around the text already shows it (a tooltip on the
   * row, a title the text sits in); the text stays inside its container
   * either way.
   */
  hint?: boolean;
  lines?: TruncatedTextLines;
  side?: React.ComponentProps<typeof TooltipPopup>["side"];
  /**
   * What the tooltip shows; the text itself by default. Pass it when the
   * children are not plain text (a highlighted search match, a link).
   */
  tooltip?: React.ReactNode;
};

/**
 * The kind of pointer that last reached each text, read when a hint is about
 * to open: a tap answers with the popover, a mouse or pen with the tooltip.
 * Weak, so a text that unmounts takes its entry with it.
 */
const LAST_POINTER_TYPE = new WeakMap<Element, string>();

function recordPointerType(event: React.PointerEvent<HTMLElement>): void {
  LAST_POINTER_TYPE.set(event.currentTarget, event.pointerType);
}

/**
 * A tap's record ends when focus leaves the text, so focus that comes back
 * from the keyboard later opens the tooltip instead of being taken for the
 * same tap.
 */
function forgetPointerType(event: React.FocusEvent<HTMLElement>): void {
  LAST_POINTER_TYPE.delete(event.currentTarget);
}

/**
 * `max-w-full` caps the text at its container even where the container does
 * not stretch it (a flex column with `items-start`, an inline-block): without
 * it a nowrap line sizes to its whole text and runs past the container.
 */
const TRUNCATED_TEXT_LINES_CLASS = {
  1: "block min-w-0 max-w-full truncate",
  2: "line-clamp-2 min-w-0 max-w-full wrap-anywhere",
  3: "line-clamp-3 min-w-0 max-w-full wrap-anywhere",
  4: "line-clamp-4 min-w-0 max-w-full wrap-anywhere",
  5: "line-clamp-5 min-w-0 max-w-full wrap-anywhere",
  6: "line-clamp-6 min-w-0 max-w-full wrap-anywhere",
  8: "line-clamp-8 min-w-0 max-w-full wrap-anywhere",
  none: "min-w-0 max-w-full",
} as const satisfies Record<TruncatedTextLines, string>;

/** Whether the element's text is cut by its box, in either direction. */
function isTextOverflowing(
  element: Pick<
    HTMLElement,
    "clientHeight" | "clientWidth" | "scrollHeight" | "scrollWidth"
  > | null,
): boolean {
  if (element === null) {
    return false;
  }
  return (
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

const CONTROL_SELECTOR =
  "a[href], button, label, summary, [role=button], [role=link], [role=menuitem], [role=option], [role=tab]";

/** Whether a tooltip around the element already opens on its pointer. */
function isInsideTooltipTrigger(element: HTMLElement): boolean {
  const parent = element.parentElement;
  return (
    parent !== null && parent.closest('[data-slot="tooltip-trigger"]') !== null
  );
}

/** Whether a tap on the element already belongs to a control around it. */
function isInsideControl(element: HTMLElement): boolean {
  return element.closest(CONTROL_SELECTOR) !== null;
}

export { TruncatedText, isTextOverflowing };
export type { TruncatedTextLines, TruncatedTextProps };
