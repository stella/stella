"use client";

import type * as React from "react";

import type { OverlayLayer } from "../lib/overlay-layer";
import { hasTooltipContent } from "../lib/tooltip-content";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

type TooltipTriggerOptions = {
  trigger: React.ReactElement;
  tooltip: React.ReactNode;
  layer?: OverlayLayer | undefined;
};

const renderTooltipTrigger = ({
  trigger,
  tooltip,
  layer,
}: TooltipTriggerOptions) => {
  if (!hasTooltipContent(tooltip)) {
    return trigger;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup {...(layer === undefined ? {} : { layer })}>
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
};

export { renderTooltipTrigger };
