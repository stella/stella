import { useSyncExternalStore } from "react";

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

/** The element a clip's rendered content sits in, in either Clips window. */
const CLIP_CONTENT_ROOT = ".clipboard-html, [contenteditable]";
/** Wrappers a selection inside them does not need to keep its formatting. */
const LAYOUT_TAGS: ReadonlySet<string> = new Set(["BLOCKQUOTE", "DIV", "P"]);
const ITEM_TAGS: ReadonlySet<string> = new Set(["LI", "TD", "TH"]);
const ITEM_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  "OL",
  "TABLE",
  "TBODY",
  "TFOOT",
  "THEAD",
  "TR",
  "UL",
]);

const isTextField = (
  element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

const selectionRanges = (selection: Selection): Range[] =>
  Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  );

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

/**
 * A range's contents as a copy would carry them. `cloneContents` stops at the
 * range's common ancestor, so a selection inside a bold run would lose the bold
 * and two list items would lose their list. Those ancestors are rebuilt up to
 * the clip's content root. A selection inside one list item or table cell stays
 * inline: copying a word out of a cell is not copying a table.
 */
const rangeContents = (range: Range): Node => {
  const contents = range.cloneContents();
  const { commonAncestorContainer: ancestor } = range;
  const innermost =
    ancestor instanceof Element ? ancestor : ancestor.parentElement;
  const root = innermost?.closest(CLIP_CONTENT_ROOT);
  if (!root) {
    return contents;
  }
  let rebuilt: Node = contents;
  let withinItem = false;
  let element = innermost;
  while (element && element !== root) {
    const { tagName } = element;
    withinItem ||= ITEM_TAGS.has(tagName);
    const keep = ITEM_CONTAINER_TAGS.has(tagName)
      ? !withinItem
      : !ITEM_TAGS.has(tagName) && !LAYOUT_TAGS.has(tagName);
    const shell = keep ? element.cloneNode(false) : null;
    if (shell instanceof Element) {
      shell.append(rebuilt);
      rebuilt = shell;
    }
    element = element.parentElement;
  }
  return rebuilt;
};

/** What a copy in the document would put on the clipboard, if anything. */
export const clipsSelection = (document: Document): ClipsSelection | null => {
  const active = document.activeElement;
  if (isTextField(active)) {
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
  for (const range of selectionRanges(selection)) {
    container.append(rangeContents(range));
  }
  const html = container.innerHTML;
  return { html: html.length > 0 ? html : null, plainText };
};

/**
 * Where the selection sits: the same text selected elsewhere is a different
 * selection, and a cut must not delete it.
 */
const selectionPosition = (document: Document): readonly unknown[] => {
  const active = document.activeElement;
  if (isTextField(active)) {
    return [active, active.selectionStart, active.selectionEnd];
  }
  const selection = document.getSelection();
  return [
    active,
    ...(selection ? selectionRanges(selection) : []).flatMap((range) => [
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    ]),
  ];
};

const samePosition = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const sameSelection = (
  left: ClipsSelection | null,
  right: ClipsSelection,
): boolean =>
  left !== null &&
  left.plainText === right.plainText &&
  left.html === right.html;

const copyFailureListeners = new Set<() => void>();
let copyFailed = false;

const setCopyFailed = (failed: boolean) => {
  if (copyFailed === failed) {
    return;
  }
  copyFailed = failed;
  for (const listener of copyFailureListeners) {
    listener();
  }
};

const subscribeCopyFailure = (listener: () => void) => {
  copyFailureListeners.add(listener);
  return () => {
    copyFailureListeners.delete(listener);
  };
};

export const isClipsCopyFailed = () => copyFailed;

/**
 * Whether the last copy in this window never reached the clipboard. The native
 * copy was already cancelled, so nothing else tells the user that a paste would
 * bring back something older. Cleared by the next copy or by leaving the window.
 */
export const useClipsCopyFailed = () =>
  useSyncExternalStore(subscribeCopyFailure, isClipsCopyFailed);

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
    const position = selectionPosition(document);
    event.preventDefault();
    setCopyFailed(false);
    void write(selection)
      .then(() => {
        // A cut removes the text only once it is safely on the clipboard,
        // and only if the selection is still the one that was written.
        if (
          event.type === "cut" &&
          samePosition(selectionPosition(document), position) &&
          sameSelection(clipsSelection(document), selection)
        ) {
          // The editing command keeps the undo stack and fires `input`, so
          // editors and controlled fields see the cut like a typed deletion.
          // oxlint-disable-next-line typescript/no-deprecated -- no standard API deletes a selection through the editing undo stack; a Range deletion would bypass undo and `input`
          document.execCommand("delete");
        }
        return undefined;
      })
      .catch((error: unknown) => {
        setCopyFailed(true);
        onFailure(error);
      });
  };
  const clearCopyFailure = () => {
    setCopyFailed(false);
  };
  document.addEventListener("copy", handle, true);
  document.addEventListener("cut", handle, true);
  document.defaultView?.addEventListener("blur", clearCopyFailure);
  return () => {
    document.removeEventListener("copy", handle, true);
    document.removeEventListener("cut", handle, true);
    document.defaultView?.removeEventListener("blur", clearCopyFailure);
    clearCopyFailure();
  };
};
