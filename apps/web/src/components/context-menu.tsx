import type { ReactNode } from "react";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import {
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/components/menu";

export type ContextMenuAction = {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
  checked?: boolean;
  submenu?: readonly ContextMenuAction[];
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
          <ContextMenuActionItem action={action} key={action.label} />
        ))}
      </MenuPopup>
    </ContextMenuPrimitive.Root>
  );
};

const ContextMenuActionItem = ({ action }: { action: ContextMenuAction }) => {
  if (action.submenu) {
    return (
      <MenuSub>
        <MenuSubTrigger>
          {action.icon}
          {action.label}
        </MenuSubTrigger>
        <MenuSubPopup>
          {action.submenu.map((sub) => (
            <ContextMenuActionItem action={sub} key={sub.label} />
          ))}
        </MenuSubPopup>
      </MenuSub>
    );
  }

  return (
    <MenuItem
      className={
        action.variant === "destructive" ? "text-destructive" : undefined
      }
      disabled={action.disabled === true}
      onClick={action.onClick}
    >
      {action.icon}
      {action.label}
    </MenuItem>
  );
};
