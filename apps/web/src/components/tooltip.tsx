import type { PropsWithChildren } from "react";

import type { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

type TooltipProps = {
  render: TooltipPrimitive.Trigger.Props["render"];
  content: React.ReactNode | undefined | null;
  align?: TooltipPrimitive.Popup.State["align"];
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
};

const Tooltip = ({
  children,
  render,
  content,
  align,
  side,
  className,
}: PropsWithChildren<TooltipProps>) => (
  <TooltipRoot>
    <TooltipTrigger render={render}>{children}</TooltipTrigger>
    <TooltipPopup
      {...(align === undefined ? {} : { align })}
      // text nowrap fixes tooltip for buttons in pdf viewer controls
      className={cn("max-w-70 text-nowrap", className)}
      hidden={content === undefined || content === null || content === ""}
      {...(side === undefined ? {} : { side })}
    >
      {content}
    </TooltipPopup>
  </TooltipRoot>
);

export default Tooltip;
