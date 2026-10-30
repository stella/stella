"use client";

import type * as React from "react";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";

import { XIcon } from "../icons";
import { OVERLAY_LAYER_CLASS_NAMES } from "../lib/overlay-layer";
import {
  SAFE_AREA_BOTTOM_EDGE_CLASS_NAME,
  SAFE_AREA_INLINE_CLASS_NAME,
  SAFE_AREA_TOP_EDGE_CLASS_NAME,
} from "../lib/safe-area";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { ScrollArea } from "./scroll-area";
import { renderTooltipTrigger } from "./tooltip-trigger-helper";

const Sheet = SheetPrimitive.Root;

const SheetPortal = SheetPrimitive.Portal;

type SheetSide = "inline-start" | "inline-end" | "block-start" | "block-end";

function SheetTrigger({
  tooltip,
  ...props
}: SheetPrimitive.Trigger.Props & { tooltip?: React.ReactNode }) {
  return renderTooltipTrigger({
    tooltip,
    trigger: <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />,
  });
}

function SheetClose({
  tooltip,
  ...props
}: SheetPrimitive.Close.Props & { tooltip?: React.ReactNode }) {
  return renderTooltipTrigger({
    tooltip,
    trigger: <SheetPrimitive.Close data-slot="sheet-close" {...props} />,
  });
}

const SheetBackdrop = ({
  className,
  ...props
}: SheetPrimitive.Backdrop.Props) => (
  <SheetPrimitive.Backdrop
    className={cn(
      "fixed inset-0 bg-black/32 backdrop-blur-sm transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
      // A sheet is modal, so it covers the docked composer the way a dialog
      // does; at z-50 the composer stayed painted over the mobile sidebar.
      OVERLAY_LAYER_CLASS_NAMES.default,
      className,
    )}
    data-slot="sheet-backdrop"
    {...props}
  />
);

const SheetViewport = ({
  className: _className,
  side,
  variant = "default",
  ...props
}: SheetPrimitive.Viewport.Props & {
  side?: SheetSide;
  variant?: "default" | "inset";
}) => (
  <SheetPrimitive.Viewport
    className={cn(
      "fixed inset-0",
      OVERLAY_LAYER_CLASS_NAMES.default,
      side === "block-end" && "grid grid-rows-[1fr_auto] pt-12",
      side === "block-start" && "grid grid-rows-[auto_1fr] pb-12",
      side === "inline-start" && "flex justify-start",
      side === "inline-end" && "flex justify-end",
      variant === "inset" && "sm:p-4",
    )}
    data-slot="sheet-viewport"
    {...props}
  />
);

const SheetPopup = ({
  className,
  children,
  showCloseButton = true,
  side = "inline-end",
  variant = "default",
  ...props
}: SheetPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  side?: SheetSide;
  variant?: "default" | "inset";
}) => (
  <SheetPortal>
    <SheetBackdrop />
    <SheetViewport side={side} variant={variant}>
      <SheetPrimitive.Popup
        className={cn(
          "bg-popover text-popover-foreground relative flex max-h-full min-h-0 w-full min-w-0 flex-col shadow-lg/5 transition-[opacity,translate] duration-200 ease-out will-change-transform not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:opacity-0 data-ending-style:duration-150 data-starting-style:opacity-0 max-sm:before:hidden dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          // The popup paints to the screen edge it is attached to; its content
          // stays clear of the notch and the home indicator on that edge.
          // After cn merges width overrides, an unconstrained w-full popup
          // reaches both inline edges and must clear both landscape insets.
          side === "block-end" && [
            "row-start-2 border-t data-ending-style:translate-y-8 data-starting-style:translate-y-8",
            SAFE_AREA_BOTTOM_EDGE_CLASS_NAME,
            SAFE_AREA_INLINE_CLASS_NAME,
          ],
          side === "block-start" && [
            "border-b data-ending-style:-translate-y-8 data-starting-style:-translate-y-8",
            SAFE_AREA_TOP_EDGE_CLASS_NAME,
            SAFE_AREA_INLINE_CLASS_NAME,
          ],
          side === "inline-start" && [
            "w-[calc(100%-(--spacing(12)))] max-w-md border-e ps-(--safe-area-inline-start) data-ending-style:-translate-x-8 data-starting-style:-translate-x-8 rtl:data-ending-style:translate-x-8 rtl:data-starting-style:translate-x-8 [&.w-full.max-w-none]:pe-(--safe-area-inline-end)",
            SAFE_AREA_TOP_EDGE_CLASS_NAME,
            SAFE_AREA_BOTTOM_EDGE_CLASS_NAME,
          ],
          side === "inline-end" && [
            "w-[calc(100%-(--spacing(12)))] max-w-md border-s pe-(--safe-area-inline-end) data-ending-style:translate-x-8 data-starting-style:translate-x-8 rtl:data-ending-style:-translate-x-8 rtl:data-starting-style:-translate-x-8 [&.w-full.max-w-none]:ps-(--safe-area-inline-start)",
            SAFE_AREA_TOP_EDGE_CLASS_NAME,
            SAFE_AREA_BOTTOM_EDGE_CLASS_NAME,
          ],
          variant === "inset" &&
            "before:hidden sm:rounded-2xl sm:border sm:before:rounded-[calc(var(--radius-2xl)-1px)] sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
          className,
        )}
        data-slot="sheet-popup"
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            aria-label="Close"
            className={cn(
              "absolute end-[calc(--spacing(2)+var(--safe-area-inline-end))] top-2",
              // Beside the status bar when the popup reaches the top edge.
              side !== "block-end" &&
                "top-[calc(--spacing(2)+var(--safe-area-top))]",
            )}
            render={<Button size="icon" variant="ghost" />}
          >
            <XIcon />
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetViewport>
  </SheetPortal>
);

const SheetHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex flex-col gap-2 p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 max-sm:pb-4",
      className,
    )}
    data-slot="sheet-header"
    {...props}
  />
);

const SheetFooter = ({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end",
      variant === "default" && "bg-muted/72 border-t py-4",
      variant === "bare" &&
        "pt-4 pb-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pt-3",
      className,
    )}
    data-slot="sheet-footer"
    {...props}
  />
);

const SheetTitle = ({ className, ...props }: SheetPrimitive.Title.Props) => (
  <SheetPrimitive.Title
    className={cn("text-xl leading-none font-semibold", className)}
    data-slot="sheet-title"
    {...props}
  />
);

const SheetDescription = ({
  className,
  ...props
}: SheetPrimitive.Description.Props) => (
  <SheetPrimitive.Description
    className={cn("text-muted-foreground text-sm", className)}
    data-slot="sheet-description"
    {...props}
  />
);

const SheetPanel = ({
  className,
  scrollFade = true,
  ...props
}: React.ComponentProps<"div"> & { scrollFade?: boolean }) => (
  <ScrollArea scrollFade={scrollFade}>
    <div
      className={cn(
        "p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-footer]:not(.border-t))]:pb-1 in-[[data-slot=sheet-popup]:has([data-slot=sheet-header])]:pt-1",
        className,
      )}
      data-slot="sheet-panel"
      {...props}
    />
  </ScrollArea>
);

export {
  Sheet,
  SheetTrigger,
  SheetPortal,
  SheetClose,
  SheetBackdrop,
  SheetBackdrop as SheetOverlay,
  SheetPopup,
  SheetPopup as SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetPanel,
};
export type { SheetSide };
