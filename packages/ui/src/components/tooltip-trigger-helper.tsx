"use client";

import type * as React from "react";

import { hasTooltipContent } from "../lib/tooltip-content";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

type TooltipTriggerOptions = {
  trigger: React.ReactElement;
  tooltip: React.ReactNode;
  keepTriggerMounted?: boolean;
};

/**
 * Overlay triggers pass only an explicit `tooltip`. They cannot tell whether
 * their content is a label or a glyph; a trigger rendered as `Button` hands its
 * `aria-label` to that Button, whose size decides (see `BUTTON_SIZE_CONTENT`).
 */
const renderTooltipTrigger = ({
  trigger,
  tooltip,
  keepTriggerMounted = false,
}: TooltipTriggerOptions) => {
  const hasContent = hasTooltipContent(tooltip);
  // Entering a disabled state must leave the focused DOM button in place.
  if (!hasContent && !keepTriggerMounted) {
    return trigger;
  }

  return (
    <Tooltip disabled={!hasContent}>
      <TooltipTrigger render={trigger} />
      {hasContent && <TooltipPopup>{tooltip}</TooltipPopup>}
    </Tooltip>
  );
};

export { renderTooltipTrigger };
