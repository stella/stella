import { Decoration } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import type { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";

const buildSelectionDecorations = (state: EditorState): Decoration[] => {
  const { doc, selection } = state;
  if (selection.empty) {
    return [];
  }

  const from = Math.max(0, Math.min(selection.from, doc.content.size));
  const to = Math.max(from, Math.min(selection.to, doc.content.size));
  if (to === from) {
    return [];
  }

  return [
    Decoration.Inline(
      from,
      to,
      { class: "prompt-editor-selected-text" },
      { inclusiveEnd: false, inclusiveStart: false },
    ),
  ];
};

const syncNativeSelection = (editor: Editor, from: number, to: number) => {
  const start = editor.view.domAtPos(from);
  const end = editor.view.domAtPos(to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

const selectPromptEditorContents = (editor: Editor | null): boolean => {
  if (editor === null || editor.isDestroyed) {
    return false;
  }

  editor.commands.selectAll();
  const { from, to } = editor.state.selection;
  editor.view.focus();

  queueMicrotask(() => {
    if (!editor.isDestroyed) {
      syncNativeSelection(editor, from, to);
    }
  });
  return true;
};

export const createPromptEditorDocument = () =>
  Document.extend({
    // ProseMirror's `selectAll` command is built in but not bound by
    // default when an editor is composed manually (no StarterKit).
    addKeyboardShortcuts() {
      return {
        "Mod-a": () => selectPromptEditorContents(this.editor),
      };
    },
    addDecorations() {
      return {
        shouldUpdate: ({ tr }) => tr.selectionSet || tr.docChanged,
        create: ({ state }) => buildSelectionDecorations(state),
      };
    },
  });

export const handlePromptEditorSelectAll = (
  event: KeyboardEvent,
  editor: Editor | null,
): boolean => {
  if (
    !(event.metaKey || event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    (event.key !== "a" && event.key !== "A")
  ) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  return selectPromptEditorContents(editor);
};
