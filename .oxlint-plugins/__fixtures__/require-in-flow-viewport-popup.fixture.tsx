import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import {
  CONTENT_SIZED_POSITIONER_CLASS_NAME,
  IN_FLOW_POPUP_CLASS_NAME,
} from "@stll/ui/positioner-sizing";

const cn = (...classes: string[]) => classes.join(" ");

export const Fixture = () => (
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
  </>
);
