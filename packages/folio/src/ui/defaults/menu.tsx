import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "../../lib/utils";
import type {
  FolioMenuCheckboxItemProps,
  FolioMenuGroupLabelProps,
  FolioMenuGroupProps,
  FolioMenuItemProps,
  FolioMenuPopupProps,
  FolioMenuRootProps,
  FolioMenuSeparatorProps,
  FolioMenuTriggerProps,
} from "../folio-ui";

/**
 * Built-in, dependency-light Menu parts used when a consumer does not inject
 * its own. Each part wraps the matching `@base-ui/react` primitive (real
 * keyboard navigation, portalling, collision-aware positioning) with minimal
 * styling. Consumers inject a polished Menu via `DocxEditor`'s `components`
 * prop.
 */

function DefaultMenuRoot(props: FolioMenuRootProps) {
  return <MenuPrimitive.Root {...props} />;
}

function DefaultMenuTrigger({
  nativeButton = true,
  ...props
}: FolioMenuTriggerProps) {
  return <MenuPrimitive.Trigger nativeButton={nativeButton} {...props} />;
}

function DefaultMenuPopup({
  className,
  children,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  alignOffset,
  ...props
}: FolioMenuPopupProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="folio-default-menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn("folio-default-menu-popup", className)}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DefaultMenuItem({ className, ...props }: FolioMenuItemProps) {
  return (
    <MenuPrimitive.Item
      className={cn("folio-default-menu-item", className)}
      {...props}
    />
  );
}

function DefaultMenuCheckboxItem({
  className,
  children,
  ...props
}: FolioMenuCheckboxItemProps) {
  return (
    <MenuPrimitive.CheckboxItem
      className={cn("folio-default-menu-checkbox-item", className)}
      {...props}
    >
      <MenuPrimitive.CheckboxItemIndicator className="folio-default-menu-checkbox-indicator">
        <svg
          aria-hidden="true"
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
          viewBox="0 0 24 24"
          width="14"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </MenuPrimitive.CheckboxItemIndicator>
      <span>{children}</span>
    </MenuPrimitive.CheckboxItem>
  );
}

function DefaultMenuGroup(props: FolioMenuGroupProps) {
  return <MenuPrimitive.Group {...props} />;
}

function DefaultMenuGroupLabel({
  className,
  ...props
}: FolioMenuGroupLabelProps) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn("folio-default-menu-group-label", className)}
      {...props}
    />
  );
}

function DefaultMenuSeparator({
  className,
  ...props
}: FolioMenuSeparatorProps) {
  return (
    <MenuPrimitive.Separator
      className={cn("folio-default-menu-separator", className)}
      {...props}
    />
  );
}

export const DefaultMenu = {
  Root: DefaultMenuRoot,
  Trigger: DefaultMenuTrigger,
  Popup: DefaultMenuPopup,
  Item: DefaultMenuItem,
  CheckboxItem: DefaultMenuCheckboxItem,
  Group: DefaultMenuGroup,
  GroupLabel: DefaultMenuGroupLabel,
  Separator: DefaultMenuSeparator,
};
