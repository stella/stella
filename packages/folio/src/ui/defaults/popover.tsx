import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "../../lib/utils";
import type {
  FolioPopoverCloseProps,
  FolioPopoverPopupProps,
  FolioPopoverRootProps,
  FolioPopoverTriggerProps,
} from "../folio-ui";

/**
 * Built-in, dependency-light Popover parts used when a consumer does not inject
 * its own. Each part wraps the matching `@base-ui/react` primitive (real focus
 * management, portalling, and collision-aware positioning) with minimal
 * styling. Consumers inject a polished Popover via `DocxEditor`'s `components`
 * prop.
 */

function DefaultPopoverRoot(props: FolioPopoverRootProps) {
  return <PopoverPrimitive.Root {...props} />;
}

function DefaultPopoverTrigger(props: FolioPopoverTriggerProps) {
  return <PopoverPrimitive.Trigger {...props} />;
}

function DefaultPopoverPopup({
  className,
  children,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  ...props
}: FolioPopoverPopupProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="folio-default-popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn("folio-default-popover-popup", className)}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function DefaultPopoverClose(props: FolioPopoverCloseProps) {
  return <PopoverPrimitive.Close {...props} />;
}

export const DefaultPopover = {
  Root: DefaultPopoverRoot,
  Trigger: DefaultPopoverTrigger,
  Popup: DefaultPopoverPopup,
  Close: DefaultPopoverClose,
};
