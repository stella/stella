"use client";

import type * as React from "react";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import {
  OVERLAY_LAYER_CLASS_NAMES,
  type OverlayLayer,
} from "../lib/overlay-layer";
import { cn } from "../lib/utils";
import { renderTooltipTrigger } from "./tooltip-trigger-helper";

const AlertDialogCreateHandle = AlertDialogPrimitive.createHandle;

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogPortal = AlertDialogPrimitive.Portal;

function AlertDialogTrigger({
  tooltip,
  ...props
}: AlertDialogPrimitive.Trigger.Props & { tooltip?: React.ReactNode }) {
  return renderTooltipTrigger({
    tooltip: tooltip ?? props["aria-label"] ?? props.title,
    trigger: (
      <AlertDialogPrimitive.Trigger
        data-slot="alert-dialog-trigger"
        nativeButton={false}
        {...props}
      />
    ),
  });
}

const AlertDialogBackdrop = ({
  className,
  layer = "default",
  ...props
}: AlertDialogPrimitive.Backdrop.Props & { layer?: OverlayLayer }) => (
  <AlertDialogPrimitive.Backdrop
    className={cn(
      "fixed inset-0 bg-black/32 backdrop-blur-sm transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0",
      OVERLAY_LAYER_CLASS_NAMES[layer],
      className,
    )}
    data-slot="alert-dialog-backdrop"
    {...props}
  />
);

const AlertDialogViewport = ({
  className,
  layer = "default",
  ...props
}: AlertDialogPrimitive.Viewport.Props & { layer?: OverlayLayer }) => (
  <AlertDialogPrimitive.Viewport
    className={cn(
      "fixed inset-0 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4",
      OVERLAY_LAYER_CLASS_NAMES[layer],
      className,
    )}
    data-slot="alert-dialog-viewport"
    {...props}
  />
);

const AlertDialogPopup = ({
  className,
  bottomStickOnMobile = true,
  layer = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  bottomStickOnMobile?: boolean;
  layer?: OverlayLayer;
}) => (
  <AlertDialogPortal>
    <AlertDialogBackdrop layer={layer} />
    <AlertDialogViewport
      className={cn(
        bottomStickOnMobile &&
          "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
      )}
      layer={layer}
    >
      <AlertDialogPrimitive.Popup
        className={cn(
          "bg-popover text-popover-foreground relative row-start-2 flex max-h-full min-h-0 w-full max-w-lg min-w-0 -translate-y-[calc(1.25rem*var(--nested-dialogs))] scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg/5 transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-ending-style:opacity-0 data-nested:data-ending-style:translate-y-8 data-nested-dialog-open:origin-top data-starting-style:scale-98 data-starting-style:opacity-0 data-nested:data-starting-style:translate-y-8 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          bottomStickOnMobile &&
            "max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:before:hidden max-sm:before:rounded-none max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4",
          className,
        )}
        data-slot="alert-dialog-popup"
        {...props}
      />
    </AlertDialogViewport>
  </AlertDialogPortal>
);

const AlertDialogHeader = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex flex-col gap-2 p-6 text-center in-[[data-slot=alert-dialog-popup]:has([data-slot=alert-dialog-panel])]:pb-3 max-sm:pb-4 sm:text-start",
      className,
    )}
    data-slot="alert-dialog-header"
    {...props}
  />
);

const AlertDialogFooter = ({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
      variant === "default" && "bg-muted/72 border-t py-4",
      variant === "bare" && "pb-6",
      className,
    )}
    data-slot="alert-dialog-footer"
    {...props}
  />
);

const AlertDialogPanel = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "px-6 pt-1 pb-6 in-[[data-slot=alert-dialog-popup]:has([data-slot=alert-dialog-footer])]:pb-4",
      className,
    )}
    data-slot="alert-dialog-panel"
    {...props}
  />
);

const AlertDialogTitle = ({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props) => (
  <AlertDialogPrimitive.Title
    className={cn("text-xl leading-none font-semibold", className)}
    data-slot="alert-dialog-title"
    {...props}
  />
);

const AlertDialogDescription = ({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) => (
  <AlertDialogPrimitive.Description
    className={cn("text-muted-foreground text-sm", className)}
    data-slot="alert-dialog-description"
    {...props}
  />
);

function AlertDialogClose({
  tooltip,
  ...props
}: AlertDialogPrimitive.Close.Props & { tooltip?: React.ReactNode }) {
  return renderTooltipTrigger({
    tooltip: tooltip ?? props["aria-label"] ?? props.title,
    trigger: (
      <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />
    ),
  });
}

export {
  AlertDialogCreateHandle,
  AlertDialog,
  AlertDialogPortal,
  AlertDialogBackdrop,
  AlertDialogBackdrop as AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogPopup,
  AlertDialogPopup as AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogPanel,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogClose,
  AlertDialogViewport,
};
