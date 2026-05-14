/**
 * Custom right-click menu that surfaces an "Anonymize selection"
 * action whenever the user right-clicks on selected text inside
 * the file preview while the Anonymization inspector facet is
 * mounted. Replaces the native context menu only in that
 * situation — bare right-clicks (no selection) pass through to
 * the browser unchanged.
 *
 * Renders via React portal at body level so the popup escapes
 * the inspector's clipping containers.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useTranslations } from "use-intl";

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
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
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
      const raw = selection.toString().replace(/\s+/g, " ").trim();
      if (
        raw.length < MIN_SELECTION_CHARS ||
        raw.length > MAX_SELECTION_CHARS
      ) {
        return;
      }
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, selection: raw });
    };
    const dismiss = () => setMenu(null);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("click", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        dismiss();
      }
    });
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("click", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, []);

  if (menu === null) {
    return null;
  }

  return createPortal(
    <div
      className="bg-popover text-popover-foreground fixed z-[100] min-w-44 rounded-md border p-1 text-sm shadow-md"
      style={{ left: menu.x, top: menu.y }}
      // Stop the outer click-to-dismiss from firing before our
      // own onClick handler can run.
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
    >
      <button
        className="hover:bg-accent hover:text-accent-foreground flex w-full items-center rounded px-2 py-1.5 text-start"
        onClick={() => {
          onAnonymize(menu.selection);
          setMenu(null);
        }}
        role="menuitem"
        type="button"
      >
        {t("inspector.anonymization.contextMenuAddAction")}
      </button>
    </div>,
    document.body,
  );
};
