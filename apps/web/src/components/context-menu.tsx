import type { ReactNode } from "react";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { MenuItem, MenuPopup } from "@stll/ui/components/menu";

export type ContextMenuAction = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  variant?: "default" | "destructive";
};

type ContextMenuProps = {
  actions: readonly ContextMenuAction[];
  children: ReactNode;
};

/**
 * Wrap arbitrary content with a right-click context menu. Built on
 * base-ui's `ContextMenu`, which is purpose-built for right-click /
 * long-press triggers — it tracks the cursor anchor itself and uses
 * dismissal semantics tuned for context menus, so the popup doesn't
 * close on incidental pointer movement the way a hover/click `Menu`
 * does.
 *
 * Renders only the children when `actions` is empty so callers can
 * pass conditionally.
 */
export const ContextMenu = ({ actions, children }: ContextMenuProps) => {
  if (actions.length === 0) {
    return <>{children}</>;
  }

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger render={<div className="contents" />}>
        {children}
      </ContextMenuPrimitive.Trigger>
      <MenuPopup>
        {actions.map((action) => (
          <MenuItem
            className={
              action.variant === "destructive" ? "text-destructive" : undefined
            }
            key={action.label}
            onClick={action.onClick}
          >
            {action.icon}
            {action.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </ContextMenuPrimitive.Root>
  );
};
