import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import {
  CONTENT_SIZED_POSITIONER_CLASS_NAME,
  IN_FLOW_POPUP_CLASS_NAME,
} from "@stll/ui/positioner-sizing";

const cn = (...classes: (string | false)[]) =>
  classes.filter((className) => className !== false).join(" ");

export const Fixture = ({ expanded }: { expanded: boolean }) => (
  <>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        className={cn(CONTENT_SIZED_POSITIONER_CLASS_NAME, "z-50")}
      >
        <TooltipPrimitive.Popup
          className={cn(IN_FLOW_POPUP_CLASS_NAME, "flex")}
        >
          <TooltipPrimitive.Viewport>content</TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>

    {/* No Viewport: nothing takes the popup out of flow, so the positioner shrink-wraps it. */}
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner className="z-50">
        <PopoverPrimitive.Popup className="flex">
          content
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>

    <PopoverPrimitive.Portal>
      {/* oxlint-disable-next-line require-in-flow-viewport-popup/require-in-flow-viewport-popup -- fixture: a Viewport-bearing positioner sized from `--positioner-width` must be reported */}
      <PopoverPrimitive.Positioner className="w-(--positioner-width)">
        <PopoverPrimitive.Popup
          className={cn(IN_FLOW_POPUP_CLASS_NAME, "flex")}
        >
          <PopoverPrimitive.Viewport>content</PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>

    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className={cn(CONTENT_SIZED_POSITIONER_CLASS_NAME, "z-50")}
      >
        {/* oxlint-disable-next-line require-in-flow-viewport-popup/require-in-flow-viewport-popup -- fixture: a popup under a Viewport that Base UI may take out of flow must be reported */}
        <PopoverPrimitive.Popup className="relative flex">
          <PopoverPrimitive.Viewport>content</PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>

    {/* A Viewport rendered from an expression container still takes the popup out of flow. */}
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className={cn(CONTENT_SIZED_POSITIONER_CLASS_NAME, "z-50")}
      >
        <PopoverPrimitive.Popup
          className={cn(IN_FLOW_POPUP_CLASS_NAME, "flex")}
        >
          {expanded && (
            <PopoverPrimitive.Viewport>content</PopoverPrimitive.Viewport>
          )}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>

    <PopoverPrimitive.Portal>
      {/* oxlint-disable-next-line require-in-flow-viewport-popup/require-in-flow-viewport-popup -- fixture: a conditionally rendered Viewport must still be found under the positioner */}
      <PopoverPrimitive.Positioner className="w-max">
        <PopoverPrimitive.Popup
          className={cn(IN_FLOW_POPUP_CLASS_NAME, "flex")}
        >
          {expanded && (
            <PopoverPrimitive.Viewport>content</PopoverPrimitive.Viewport>
          )}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>

    <PopoverPrimitive.Portal>
      {/* oxlint-disable-next-line require-in-flow-viewport-popup/require-in-flow-viewport-popup -- fixture: a positioner that drops the sizing class on one branch must be reported */}
      <PopoverPrimitive.Positioner
        className={cn(
          expanded ? CONTENT_SIZED_POSITIONER_CLASS_NAME : "w-max",
          "z-50",
        )}
      >
        <PopoverPrimitive.Popup
          className={cn(IN_FLOW_POPUP_CLASS_NAME, "flex")}
        >
          <PopoverPrimitive.Viewport>content</PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>

    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className={cn(CONTENT_SIZED_POSITIONER_CLASS_NAME, "z-50")}
      >
        {/* oxlint-disable-next-line require-in-flow-viewport-popup/require-in-flow-viewport-popup -- fixture: a popup that keeps the in-flow class on one branch only must be reported */}
        <PopoverPrimitive.Popup
          className={cn(expanded && IN_FLOW_POPUP_CLASS_NAME, "flex")}
        >
          <PopoverPrimitive.Viewport>content</PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  </>
);
