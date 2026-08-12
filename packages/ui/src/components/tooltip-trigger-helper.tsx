"use client";

import type * as React from "react";

import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";
import type { OverlayLayer } from "@stll/ui/lib/overlay-layer";
import { hasTooltipContent } from "@stll/ui/lib/tooltip-content";

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
