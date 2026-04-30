/**
 * Tooltip adapter
 *
 * Preserves the backward-compatible single-wrapper API (`<Tooltip content="...">child</Tooltip>`)
 * while delegating to Stella's compound tooltip under the hood.
 */

import type * as React from "react";

import {
  Tooltip as TooltipRoot,
  TooltipProvider,
  TooltipTrigger,
  TooltipPopup,
} from "@stll/ui/components/tooltip";

type TooltipProps = {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  delayMs?: number;
};

export function Tooltip({
  content,
  children,
  side = "bottom",
  delayMs = 400,
}: TooltipProps) {
  return (
    <TooltipProvider delay={delayMs}>
      <TooltipRoot>
        <TooltipTrigger render={children} />
        <TooltipPopup side={side} className="max-w-70 text-nowrap">
          {content}
        </TooltipPopup>
      </TooltipRoot>
    </TooltipProvider>
  );
}
