/**
 * Custom right-click menu that surfaces an "Anonymize selection"
 * action whenever the user right-clicks on selected text inside
 * the file preview while the Anonymization inspector facet is
 * mounted. Replaces the native context menu only in that
 * situation — bare right-clicks (no selection) pass through to
 * the browser unchanged.
 *
 * The popup is the design system's `Menu`, anchored at the pointer: it
 * portals out of the inspector's clipping containers and owns focus,
 * keyboard navigation, Escape and outside-press dismissal.
 */

import { useRef, useState } from "react";

import { useTranslations } from "use-intl";

import { Menu, MenuItem, MenuPopup } from "@stll/ui/menu";

import { useMountEffect } from "@/hooks/use-effect";

const MIN_SELECTION_CHARS = 2;
const MAX_SELECTION_CHARS = 200;

type MenuState = {
  x: number;
  y: number;
  selection: string;
};

type AnonymizationContextMenuProps = {
  /** Called with the captured selection when the user picks the action. */
  onAnonymize: (selection: string) => void;
};

export const AnonymizationContextMenu = ({
  onAnonymize,
}: AnonymizationContextMenuProps) => {
  const t = useTranslations();
  // The last place the menu opened stays put while it closes, so the popup
  // animates out where it was instead of jumping to the corner.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [open, setOpen] = useState(false);
  // Where focus was when the right-click opened the menu, so closing it
  // hands focus back to the document instead of the page body.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useMountEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target;
      // Only act inside the file preview area — the doc text lives
      // under the `.layout-page` container. Skipping anywhere else
      // (sidebar, toolbar, input fields) keeps the native menu for
      // those surfaces.
      if (!(target instanceof Element)) {
        return;
      }
      if (!target.closest(".layout-page")) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }
      const raw = selection.toString().replace(/\s+/gu, " ").trim();
      if (
        raw.length < MIN_SELECTION_CHARS ||
        raw.length > MAX_SELECTION_CHARS
      ) {
        return;
      }
      event.preventDefault();
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setMenu({ x: event.clientX, y: event.clientY, selection: raw });
      // Open on the next frame: the right-click's trailing pointerup would
      // otherwise count as a press outside the menu it just opened.
      requestAnimationFrame(() => setOpen(true));
    };
    // The menu is pinned to where the pointer was; once the page under it
    // moves or the window loses focus, that point means nothing.
    const dismiss = () => setOpen(false);
    document.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  });

  if (menu === null) {
    return null;
  }

  return (
    // Not modal: the page keeps scrolling (which dismisses the menu) and the
    // first press outside lands where it was aimed.
    <Menu modal={false} onOpenChange={setOpen} open={open}>
      <MenuPopup
        anchor={{
          getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0),
        }}
        finalFocus={returnFocusRef}
        onContextMenu={(event) => event.preventDefault()}
      >
        <MenuItem onClick={() => onAnonymize(menu.selection)}>
          {t("inspector.anonymization.contextMenuAddAction")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
};
