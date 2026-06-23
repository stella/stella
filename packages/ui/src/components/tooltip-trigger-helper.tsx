"use client";

import type * as React from "react";

import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";

type TooltipTriggerOptions = {
  trigger: React.ReactElement;
  tooltip: React.ReactNode | undefined | false;
};

const renderTooltipTrigger = ({ trigger, tooltip }: TooltipTriggerOptions) => {
  if (
    tooltip === undefined ||
    tooltip === null ||
    tooltip === "" ||
    tooltip === false
  ) {
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
