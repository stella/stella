/**
 * Keyboard classification for the inspector's docked DOCX find bar.
 *
 * Folio ships its own find/replace dialog on a document-level `keydown`
 * listener. In the inspector that dialog is a viewport overlay pushed clear
 * of the docked pane, so it lands on top of unrelated page content. The
 * inspector claims the shortcut instead; this module owns the decision of
 * which key events it may claim, so the suppression stays testable.
 */

type DocxFindKeyEvent = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
};

type ClassifyDocxFindKeydownOptions = {
  event: DocxFindKeyEvent;
  isOpen: boolean;
};

export type DocxFindKeydownAction =
  | { type: "closeFind" }
  | { type: "none" }
  | { type: "openFind" };

const NO_ACTION = { type: "none" } as const satisfies DocxFindKeydownAction;

export const classifyDocxFindKeydown = ({
  event,
  isOpen,
}: ClassifyDocxFindKeydownOptions): DocxFindKeydownAction => {
  if (event.key === "Escape") {
    return isOpen ? { type: "closeFind" } : NO_ACTION;
  }

  // Claim the bare Cmd/Ctrl+F only. Every other combination (Cmd+Alt+F,
  // Cmd+Shift+F) stays with Folio and the browser.
  if (event.altKey || event.shiftKey) {
    return NO_ACTION;
  }
  if (!event.metaKey && !event.ctrlKey) {
    return NO_ACTION;
  }
  return event.key.toLowerCase() === "f" ? { type: "openFind" } : NO_ACTION;
};
