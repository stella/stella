import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { PromptSlashList } from "@/components/chat/prompt-slash-list";
import type { ChatPrompt } from "@/lib/prompts/types";

const PLUGIN_NAME = "promptSlash";

type PromptSlashOptions = {
  suggestion: Omit<SuggestionOptions<ChatPrompt, ChatPrompt>, "editor">;
};

/**
 * `/`-triggered TipTap extension that lets the user pick a saved
 * prompt and drop its body into the composer. Triggers only at
 * the start of an empty paragraph (so a `/` mid-sentence is just
 * a slash). Selection inserts the prompt's `body` as plain text
 * and removes the trigger range.
 */
export const PromptSlash = Extension.create<PromptSlashOptions>({
  name: PLUGIN_NAME,

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: true,
        allowSpaces: false,
        items: () => [],
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent(props.body)
            .run();
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

const filterPrompts = (prompts: ChatPrompt[], query: string): ChatPrompt[] => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return prompts;
  }
  return prompts.filter(
    (prompt) =>
      prompt.name.toLowerCase().includes(trimmed) ||
      prompt.body.toLowerCase().includes(trimmed),
  );
};

/**
 * Build the Suggestion config used by `PromptSlash`. `getPrompts`
 * is read on every keystroke so the host can mix stock and DB-backed
 * prompts (Stage 3) without re-creating the extension.
 */
export const createPromptSlashSuggestion = (
  getPrompts: () => ChatPrompt[],
): Omit<SuggestionOptions<ChatPrompt, ChatPrompt>, "editor"> => ({
  char: "/",
  startOfLine: true,
  allowSpaces: false,
  items: ({ query }) => filterPrompts(getPrompts(), query),

  command: ({ editor, range, props }) => {
    editor.chain().focus().deleteRange(range).insertContent(props.body).run();
  },

  render: () => {
    let component: ReactRenderer<
      ReturnType<NonNullable<SuggestionOptions["render"]>>,
      SuggestionProps<ChatPrompt>
    > | null = null;

    return {
      onStart: (props: SuggestionProps<ChatPrompt>) => {
        if (!props.clientRect) {
          return;
        }
        component = new ReactRenderer(PromptSlashList, {
          props,
          editor: props.editor,
        });
      },
      onUpdate: (props: SuggestionProps<ChatPrompt>) => {
        component?.updateProps(props);
      },
      onKeyDown: (props) => Boolean(component?.ref?.onKeyDown?.(props)),
      onExit: () => {
        component?.destroy();
        component = null;
      },
    };
  },
});
