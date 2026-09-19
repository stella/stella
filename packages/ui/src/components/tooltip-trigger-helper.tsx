"use client";

import type * as React from "react";

import { hasTooltipContent } from "../lib/tooltip-content";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

type TooltipTriggerOptions = {
  trigger: React.ReactElement;
  tooltip: React.ReactNode;
};

const renderTooltipTrigger = ({ trigger, tooltip }: TooltipTriggerOptions) => {
  if (!hasTooltipContent(tooltip)) {
    return trigger;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
};

export { renderTooltipTrigger };
