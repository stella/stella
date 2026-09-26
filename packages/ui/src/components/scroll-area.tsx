"use client";

import type { Ref } from "react";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "../lib/utils";

/**
 * Which way the area may scroll. `both` is the primitive's own behaviour: a
 * viewport that scrolls whichever axis its content overflows. `vertical` is
 * for a surface whose inline size belongs to the reader rather than to its
 * content — a resizable pane, a column that can be dragged down to 320px —
 * where a sideways scrollbar means something inside refused to wrap, and the
 * honest answer is to make it wrap. An element that genuinely needs the axis
 * (a wide table, a code block) carries its own `overflow-x-auto` and scrolls
 * locally, inside the column.
 */
type ScrollAreaAxis = "both" | "vertical";

const AXIS_VIEWPORT_CLASS = {
  both: "",
  vertical: "overflow-x-hidden",
} as const satisfies Record<ScrollAreaAxis, string>;

const ScrollArea = ({
  axis = "both",
  className,
  children,
  scrollFade = false,
  scrollbarClassName,
  scrollbarGutter = false,
  viewportRef,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  axis?: ScrollAreaAxis;
  scrollFade?: boolean;
  /**
   * Extra classes applied to both scrollbars, on top of their default
   * styling — the escape hatch for a consumer whose scrollbar must win a
   * stacking fight against a sibling with its own z-index (e.g. a floating
   * composer veil docked over the scroll area). Omit for the default
   * (unelevated) overlay-thumb treatment.
   */
  scrollbarClassName?: string;
  scrollbarGutter?: boolean;
  viewportRef?: Ref<HTMLDivElement>;
}) => (
  <ScrollAreaPrimitive.Root
    className={cn("size-full min-h-0", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      ref={viewportRef}
      className={cn(
        "focus-visible:ring-ring focus-visible:ring-offset-background h-full overscroll-contain rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-offset-1 data-has-overflow-x:overscroll-x-contain",
        scrollFade &&
          "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] [--fade-size:1.5rem]",
        scrollbarGutter &&
          "data-has-overflow-x:pb-2.5 data-has-overflow-y:pe-2.5",
        AXIS_VIEWPORT_CLASS[axis],
      )}
      data-slot="scroll-area-viewport"
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar className={scrollbarClassName} orientation="vertical" />
    {axis === "both" && (
      <ScrollBar className={scrollbarClassName} orientation="horizontal" />
    )}
    <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
  </ScrollAreaPrimitive.Root>
);

const ScrollBar = ({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) => (
  <ScrollAreaPrimitive.Scrollbar
    className={cn(
      "m-1 flex opacity-0 transition-opacity delay-300 data-hovering:opacity-100 data-hovering:delay-0 data-hovering:duration-100 data-scrolling:opacity-100 data-scrolling:delay-0 data-scrolling:duration-100 data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:w-1.5",
      className,
    )}
    data-slot="scroll-area-scrollbar"
    orientation={orientation}
    {...props}
  >
    <ScrollAreaPrimitive.Thumb
      className="bg-foreground/20 relative flex-1 rounded-full"
      data-slot="scroll-area-thumb"
    />
  </ScrollAreaPrimitive.Scrollbar>
);

export { ScrollArea, ScrollBar };
