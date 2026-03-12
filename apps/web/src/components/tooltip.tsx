import type { PropsWithChildren } from "react";

import type { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stella/ui/components/tooltip";
import { cn } from "@stella/ui/lib/utils";

type TooltipProps = {
  render: TooltipPrimitive.Trigger.Props["render"];
  content: React.ReactNode | undefined | null;
  align?: TooltipPrimitive.Popup.State["align"];
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
};

export default function Tooltip({
  children,
  render,
  content,
  align,
  side,
  className,
}: PropsWithChildren<TooltipProps>) {
  return (
    <TooltipRoot>
      <TooltipTrigger render={render}>{children}</TooltipTrigger>
      <TooltipPopup
        align={align}
        // text nowrap fixes tooltip for buttons in pdf viewer controls
        className={cn("max-w-70 text-nowrap", className)}
        hidden={content === undefined || content === null || content === ""}
        side={side}
      >
        {content}
      </TooltipPopup>
    </TooltipRoot>
  );
}
