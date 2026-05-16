import "./prompt-editor.css";
import type React from "react";

import Document from "@tiptap/extension-document";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/react";

import { cn } from "@stll/ui/lib/utils";

export const PROMPT_EDITOR_SELECTION_CLASS = "prompt-editor-selection";

type PromptSelectionDecorationState = {
  decorationSet: DecorationSet;
};

const promptSelectionDecorationsKey =
  new PluginKey<PromptSelectionDecorationState>(
    "promptEditorSelectionDecorations",
  );

const buildSelectionDecorationSet = (state: EditorState): DecorationSet => {
  const { doc, selection } = state;
  if (selection.empty) {
    return DecorationSet.empty;
  }

  const from = Math.max(0, Math.min(selection.from, doc.content.size));
  const to = Math.max(from, Math.min(selection.to, doc.content.size));
  if (to === from) {
    return DecorationSet.empty;
  }

  return DecorationSet.create(doc, [
    Decoration.inline(
      from,
      to,
      { class: "prompt-editor-selected-text" },
      { inclusiveEnd: false, inclusiveStart: false },
    ),
  ]);
};

const createSelectionDecorationPlugin = () =>
  new Plugin<PromptSelectionDecorationState>({
    key: promptSelectionDecorationsKey,
    state: {
      init(_, state): PromptSelectionDecorationState {
        return {
          decorationSet: buildSelectionDecorationSet(state),
        };
      },
      apply(tr, previous, _oldState, newState): PromptSelectionDecorationState {
        if (!tr.selectionSet && !tr.docChanged) {
          return previous;
        }

        return {
          decorationSet: buildSelectionDecorationSet(newState),
        };
      },
    },
    props: {
      decorations(state) {
        return (
          promptSelectionDecorationsKey.getState(state)?.decorationSet ?? null
        );
      },
    },
  });

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

export const selectPromptEditorContents = (editor: Editor | null): boolean => {
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
    addProseMirrorPlugins() {
      return [createSelectionDecorationPlugin()];
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

type PromptEditorContentProps = Omit<
  React.ComponentProps<typeof EditorContent>,
  "editor"
> & {
  editor: Editor | null;
};

export const PromptEditorContent = ({
  className,
  editor,
  ...props
}: PromptEditorContentProps) => (
  <EditorContent
    className={cn(PROMPT_EDITOR_SELECTION_CLASS, className)}
    editor={editor}
    {...props}
  />
);
