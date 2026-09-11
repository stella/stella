import { useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";

import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/menu";

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
export const useAnchoredMenu = ({
  children,
  returnFocus: providedReturnFocus,
}: {
  children: ReactNode;
  returnFocus?: RefObject<HTMLElement | null>;
}) => {
  const localReturnFocus = useRef<HTMLElement | null>(null);
  const returnFocus = providedReturnFocus ?? localReturnFocus;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  const openAt = (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const x = "clientX" in event ? event.clientX : 0;
    const y = "clientY" in event ? event.clientY : 0;
    const trigger = event.currentTarget;
    returnFocus.current = trigger;
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

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      openAt(event);
    }
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
      <MenuPopup anchor={anchor ?? undefined} finalFocus={returnFocus}>
        {children}
      </MenuPopup>
    </Menu>
  );

  return { open, openAt, onKeyDown, close, element };
};
