import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "../../lib/utils";
import type {
  FolioSelectItemProps,
  FolioSelectPopupProps,
  FolioSelectRootProps,
  FolioSelectTriggerProps,
  FolioSelectValueProps,
} from "../folio-ui";

/**
 * Built-in, dependency-light Select parts used when a consumer does not inject
 * its own. Each part wraps the matching `@base-ui/react` primitive (real
 * listbox semantics, keyboard navigation, portalled positioning) with minimal
 * styling. The default popup omits the scroll arrows and item-aligned
 * positioning of a fully styled design-system Select; consumers inject their
 * own Select via `DocxEditor`'s `components` prop for that polish.
 */

function DefaultSelectRoot(props: FolioSelectRootProps) {
  return <SelectPrimitive.Root {...props} />;
}

function DefaultSelectTrigger({
  className,
  children,
  ...props
}: FolioSelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      className={cn("folio-default-select-trigger", className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="folio-default-select-icon">
        <svg
          aria-hidden="true"
          fill="none"
          height="16"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="16"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
        </svg>
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function DefaultSelectValue({ className, ...props }: FolioSelectValueProps) {
  return (
    <SelectPrimitive.Value
      className={cn("folio-default-select-value", className)}
      {...props}
    />
  );
}

function DefaultSelectPopup({
  className,
  children,
  ...props
}: FolioSelectPopupProps) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align="start"
        className="folio-default-select-positioner"
        side="bottom"
        sideOffset={4}
      >
        <SelectPrimitive.Popup
          className={cn("folio-default-select-popup", className)}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function DefaultSelectItem({
  className,
  children,
  ...props
}: FolioSelectItemProps) {
  return (
    <SelectPrimitive.Item
      className={cn("folio-default-select-item", className)}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export const DefaultSelect = {
  Root: DefaultSelectRoot,
  Trigger: DefaultSelectTrigger,
  Value: DefaultSelectValue,
  Popup: DefaultSelectPopup,
  Item: DefaultSelectItem,
};
