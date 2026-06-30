import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/components/menu";

type AnchorRect = {
  getBoundingClientRect: () => DOMRect;
};

/**
 * Cursor-anchored context menu primitive shared by the inspector
 * rail (`useRailContextMenu`) and per-tab actions
 * (`useTabContextMenu`). Wraps the same anchor-ref + sr-only
 * trigger boilerplate both surfaces need so a third surface can
 * compose without duplicating it.
 *
 * Usage: render `element` somewhere in the tree and call `openAt`
 * from a `onContextMenu` handler. The hook owns the open/close
 * state and clears the anchor on close.
 */
export const useAnchoredMenu = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  const openAt = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const x = event.clientX;
    const y = event.clientY;
    const trigger = event.currentTarget;
    // Keyboard / assistive-tech activations dispatch a click with no
    // pointer position (clientX/clientY are 0); anchor to the triggering
    // element so the menu opens beside it instead of the viewport corner.
    const anchorRect: AnchorRect =
      x !== 0 || y !== 0
        ? { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }
        : { getBoundingClientRect: () => trigger.getBoundingClientRect() };
    setAnchor(anchorRect);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setAnchor(null);
  };

  const element = (
    <Menu
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setAnchor(null);
        }
      }}
      open={open}
    >
      <MenuTrigger nativeButton={false} render={<span className="sr-only" />} />
      <MenuPopup anchor={anchor ?? undefined}>{children}</MenuPopup>
    </Menu>
  );

  return { openAt, close, element };
};
