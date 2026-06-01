import { type ReactNode, useState } from "react";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";

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
 * Wrap arbitrary content with a right-click context menu. The menu
 * opens at the cursor position via a virtual anchor — same pattern as
 * `NavContextMenu` in `app-sidebar.tsx`. Renders nothing extra when
 * `actions` is empty so callers can pass conditionally.
 */
export const ContextMenu = ({ actions, children }: ContextMenuProps) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  if (actions.length === 0) {
    return <>{children}</>;
  }

  return (
    <div
      className="contents"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const x = e.clientX;
        const y = e.clientY;
        setAnchor({
          getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
        });
        setOpen(true);
      }}
    >
      {children}
      <Menu
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setAnchor(null);
          }
        }}
        open={open}
      >
        <MenuTrigger
          nativeButton={false}
          render={<span className="sr-only" />}
        />
        <MenuPopup anchor={anchor ?? undefined}>
          {actions.map((action) => (
            <MenuItem
              className={
                action.variant === "destructive"
                  ? "text-destructive"
                  : undefined
              }
              key={action.label}
              onClick={action.onClick}
            >
              {action.icon}
              {action.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
};
