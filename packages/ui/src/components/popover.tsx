"use client";

import type * as React from "react";
import type { ComponentProps } from "react";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import {
  OVERLAY_COLLISION_PADDING,
  OVERLAY_LAYER_CLASS_NAMES,
  type OverlayLayer,
} from "../lib/overlay-layer";
import { cn } from "../lib/utils";
import { renderTooltipTrigger } from "./tooltip-trigger-helper";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger({
  tooltip,
  ...props
}: PopoverPrimitive.Trigger.Props & { tooltip?: React.ReactNode }) {
  return renderTooltipTrigger({
    tooltip: tooltip ?? props["aria-label"] ?? props.title,
    trigger: (
      <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
    ),
  });
}

const PopoverPopup = ({
  children,
  className,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  tooltipStyle = false,
  anchor,
  layer = "default",
  ...props
}: PopoverPrimitive.Popup.Props & {
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  layer?: OverlayLayer;
  tooltipStyle?: boolean;
}) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Positioner
      align={align}
      alignOffset={alignOffset}
      anchor={anchor}
      // `--positioner-width` is written from the popup *payload*, so a popup
      // whose content grows from local state (a picker swapping to an editor)
      // left the positioner at the old width. Base UI collision-tests the
      // positioner, so `shift()` saw no overflow while the popup rendered wider
      // and ran off-screen. Sizing to content keeps the two in step; the popup
      // still animates its own width through `--popup-width`, and `max-content`
      // tracks that as it interpolates.
      className={cn(
        "h-(--positioner-height) w-max max-w-(--available-width)",
        OVERLAY_LAYER_CLASS_NAMES[layer],
      )}
      collisionPadding={OVERLAY_COLLISION_PADDING}
      data-slot="popover-positioner"
      side={side}
      sideOffset={sideOffset}
    >
      <PopoverPrimitive.Popup
        className={cn(
          "bg-popover text-popover-foreground relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg border shadow-lg/5 transition-[width,height,scale,opacity] not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          tooltipStyle &&
            "w-fit rounded-md text-xs text-balance shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]",
          className,
        )}
        data-slot="popover-popup"
        {...props}
      >
        <PopoverPrimitive.Viewport
          className={cn(
            "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-4 outline-none [--viewport-inline-padding:--spacing(4)] **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-current:transition-opacity **:data-current:data-ending-style:opacity-0 data-instant:transition-none **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:opacity-100 **:data-previous:transition-opacity **:data-previous:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-starting-style:opacity-0",
            tooltipStyle
              ? "py-1 [--viewport-inline-padding:--spacing(2)]"
              : "not-data-transitioning:overflow-y-auto",
          )}
          data-slot="popover-viewport"
        >
          {children}
        </PopoverPrimitive.Viewport>
      </PopoverPrimitive.Popup>
    </PopoverPrimitive.Positioner>
  </PopoverPrimitive.Portal>
);

/**
 * Popover surface with the content layout baked in: children stack in a vertical
 * flex container. coss renders popup children inside a separate inner Viewport,
 * so layout utilities placed on the popup `className` silently miss the content.
 * This wrapper removes that footgun — `className` styles the surface (e.g.
 * width), `contentClassName` tweaks the content stack.
 */
const PopoverPanel = ({
  children,
  contentClassName,
  ...props
}: ComponentProps<typeof PopoverPopup> & { contentClassName?: string }) => (
  <PopoverPopup {...props}>
    <div className={cn("flex flex-col gap-3", contentClassName)}>
      {children}
    </div>
  </PopoverPopup>
);

const PopoverClose = ({ ...props }: PopoverPrimitive.Close.Props) => (
  <PopoverPrimitive.Close data-slot="popover-close" {...props} />
);

const PopoverTitle = ({
  className,
  ...props
}: PopoverPrimitive.Title.Props) => (
  <PopoverPrimitive.Title
    className={cn("text-lg leading-none font-semibold", className)}
    data-slot="popover-title"
    {...props}
  />
);

const PopoverDescription = ({
  className,
  ...props
}: PopoverPrimitive.Description.Props) => (
  <PopoverPrimitive.Description
    className={cn("text-muted-foreground text-sm", className)}
    data-slot="popover-description"
    {...props}
  />
);

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverPopup as PopoverContent,
  PopoverPanel,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
};
