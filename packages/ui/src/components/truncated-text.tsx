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
    // A tap focuses the text before it clicks; the popover answers taps.
    if (element === null || LAST_POINTER_TYPE.get(element) === "touch") {
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

/** How many lines the text may take before it is cut. */
type TruncatedTextLines = 1 | 2 | 3;

type TruncatedTextProps = useRender.ComponentProps<"span"> & {
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

const TRUNCATED_TEXT_LINES_CLASS = {
  1: "block min-w-0 truncate",
  2: "line-clamp-2 min-w-0 wrap-anywhere",
  3: "line-clamp-3 min-w-0 wrap-anywhere",
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

/** Whether a tap on the element already belongs to a control around it. */
function isInsideControl(element: HTMLElement): boolean {
  return element.closest(CONTROL_SELECTOR) !== null;
}

export { TruncatedText, isTextOverflowing };
export type { TruncatedTextLines, TruncatedTextProps };
