import { invoke } from "@tauri-apps/api/core";

/**
 * Copies made inside a Clips window (the panel or the editor) never become new
 * clips. A native copy would reach the system clipboard unmarked and the
 * watcher would record it, feeding the history its own contents; instead every
 * copy and cut is written by the backend with the internal marker.
 */

export type ClipsSelection = {
  html: string | null;
  plainText: string;
};

const CLIPS_COPY_WINDOW_LABELS: ReadonlySet<string> = new Set([
  "clipboard",
  "clipboard-editor",
]);

const textFieldSelection = (
  field: HTMLInputElement | HTMLTextAreaElement,
): ClipsSelection | null => {
  if (field instanceof HTMLInputElement && field.type === "password") {
    return null;
  }
  const { selectionEnd, selectionStart, value } = field;
  if (
    selectionStart === null ||
    selectionEnd === null ||
    selectionStart === selectionEnd
  ) {
    return null;
  }
  return { html: null, plainText: value.slice(selectionStart, selectionEnd) };
};

/** What a copy in the document would put on the clipboard, if anything. */
export const clipsSelection = (document: Document): ClipsSelection | null => {
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    return textFieldSelection(active);
  }
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const plainText = selection.toString();
  if (plainText.length === 0) {
    return null;
  }
  const container = document.createElement("div");
  for (const index of Array.from(
    { length: selection.rangeCount },
    (_, rangeIndex) => rangeIndex,
  )) {
    container.append(selection.getRangeAt(index).cloneContents());
  }
  const html = container.innerHTML;
  return { html: html.length > 0 ? html : null, plainText };
};

const sameSelection = (
  left: ClipsSelection | null,
  right: ClipsSelection,
): boolean =>
  left !== null &&
  left.plainText === right.plainText &&
  left.html === right.html;

type InstallClipsCopyRoutingOptions = {
  document: Document;
  windowLabel: string;
  write?: (selection: ClipsSelection) => Promise<unknown>;
  onFailure: (error: unknown) => void;
};

const writeClipsSelection = async (selection: ClipsSelection) =>
  await invoke("clipboard_copy_selection", { ...selection });

export const installClipsCopyRouting = ({
  document,
  windowLabel,
  write = writeClipsSelection,
  onFailure,
}: InstallClipsCopyRoutingOptions) => {
  if (!CLIPS_COPY_WINDOW_LABELS.has(windowLabel)) {
    return () => undefined;
  }
  const handle = (event: ClipboardEvent) => {
    const selection = clipsSelection(document);
    if (!selection) {
      return;
    }
    event.preventDefault();
    void write(selection)
      .then(() => {
        // A cut removes the text only once it is safely on the clipboard,
        // and only if the selection is still the one that was written.
        if (
          event.type === "cut" &&
          sameSelection(clipsSelection(document), selection)
        ) {
          // The editing command keeps the undo stack and fires `input`, so
          // editors and controlled fields see the cut like a typed deletion.
          // oxlint-disable-next-line typescript/no-deprecated -- no standard API deletes a selection through the editing undo stack; a Range deletion would bypass undo and `input`
          document.execCommand("delete");
        }
        return undefined;
      })
      .catch(onFailure);
  };
  document.addEventListener("copy", handle, true);
  document.addEventListener("cut", handle, true);
  return () => {
    document.removeEventListener("copy", handle, true);
    document.removeEventListener("cut", handle, true);
  };
};
