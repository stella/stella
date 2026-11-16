import { nativeTextContextMenuReason } from "@stll/ui/native-context-menu";

// The desktop webview's own right-click menu is a browser's: reload, inspect,
// back. None of it belongs in an app window. A right-click the page handled
// (an object's actions, through EntityActions) has already prevented it;
// every other right-click shows no menu, except on editable or selected text,
// which keeps the webview's text menu (cut, copy, paste, spelling).

type ContextMenuEventLike = Pick<MouseEvent, "defaultPrevented" | "target"> & {
  preventDefault: () => void;
};

/** Hides the webview's menu for one right-click the page left unhandled. */
const suppressBrowserContextMenu = (event: ContextMenuEventLike) => {
  if (event.defaultPrevented || nativeTextContextMenuReason(event) !== null) {
    return;
  }
  event.preventDefault();
};

/**
 * Installs the policy for one window. It listens on the document in the
 * bubble phase, after the page's own handlers had their turn, and returns the
 * remover.
 */
export const installNativeContextMenuPolicy = (target: Document) => {
  target.addEventListener("contextmenu", suppressBrowserContextMenu);
  return () => {
    target.removeEventListener("contextmenu", suppressBrowserContextMenu);
  };
};
