"use client";

import type React from "react";

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { cn } from "@stll/ui/lib/utils";

export const PreviewCard: typeof PreviewCardPrimitive.Root =
  PreviewCardPrimitive.Root;

export function PreviewCardTrigger({
  ...props
}: PreviewCardPrimitive.Trigger.Props): React.ReactElement {
  return (
    <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />
  );
}

export function PreviewCardPopup({
  className,
  children,
  align = "center",
  sideOffset = 4,
  anchor,
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
  anchor?: PreviewCardPrimitive.Positioner.Props["anchor"];
}): React.ReactElement {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="z-50"
        data-slot="preview-card-positioner"
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitive.Popup
          className={cn(
            "bg-popover text-popover-foreground relative flex w-64 origin-(--transform-origin) rounded-lg border p-4 text-sm text-balance shadow-lg/5 transition-[scale,opacity] not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
          data-slot="preview-card-content"
          {...props}
        >
          {children}
        </PreviewCardPrimitive.Popup>
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export {
  PreviewCardPrimitive,
  PreviewCard as HoverCard,
  PreviewCardTrigger as HoverCardTrigger,
  PreviewCardPopup as HoverCardContent,
};
