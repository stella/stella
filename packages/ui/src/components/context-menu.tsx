"use client";

import type { ReactNode } from "react";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "../lib/utils";
import {
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "./menu";

export type ContextMenuAction = {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
  /** Set on a toggle-style action: it renders as a checkbox item whose
   *  state assistive technology can read. `onClick` flips it. */
  checked?: boolean;
  submenu?: readonly ContextMenuAction[];
  /** Draw a divider above this item — e.g. to set a trailing "New …" action
   *  apart from the list of existing choices above it. */
  separatorBefore?: boolean;
  /** Keep the menu open after the click, for a toggle the user may flip
   *  several of in a row. */
  closeOnClick?: boolean;
};

export type ContextMenuProps = {
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
// Explicit ReactNode: returning bare `children` infers a type containing
// React 19's Promise<AwaitedReactNode> member, which promise-function-async
// would otherwise flag on this intentionally sync component.
export const ContextMenu = ({
  actions,
  children,
}: ContextMenuProps): ReactNode => {
  if (actions.length === 0) {
    return children;
  }

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger
        data-slot="context-menu-trigger"
        render={<div className="contents" />}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <MenuPopup data-slot="context-menu-popup">
        {actions.map((action) => (
          <ContextMenuActionItem action={action} key={action.label} />
        ))}
      </MenuPopup>
    </ContextMenuPrimitive.Root>
  );
};

const ContextMenuActionItem = ({ action }: { action: ContextMenuAction }) => {
  const separator = action.separatorBefore ? <MenuSeparator /> : null;

  if (action.submenu) {
    return (
      <>
        {separator}
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
      </>
    );
  }

  if (action.checked !== undefined) {
    // A toggle is a checkbox item, so assistive technology reads its state
    // (`menuitemcheckbox` with `aria-checked`) rather than a bare glyph.
    return (
      <>
        {separator}
        <MenuCheckboxItem
          checked={action.checked}
          closeOnClick={action.closeOnClick ?? true}
          disabled={action.disabled === true}
          onCheckedChange={() => action.onClick?.()}
        >
          {action.icon}
          {action.label}
        </MenuCheckboxItem>
      </>
    );
  }

  return (
    <>
      {separator}
      <MenuItem
        className={cn(action.variant === "destructive" && "text-destructive")}
        closeOnClick={action.closeOnClick ?? true}
        disabled={action.disabled === true}
        onClick={action.onClick}
      >
        {action.icon}
        {action.label}
      </MenuItem>
    </>
  );
};
