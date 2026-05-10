import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { insertPastedTextChip } from "@/components/chat-pasted-text-extension";
import { PromptSlashList } from "@/components/chat/prompt-slash-list";
import type { ChatPrompt } from "@/lib/prompts/types";

const insertPromptAsChip = (
  editor: Editor,
  range: { from: number; to: number },
  prompt: ChatPrompt,
) => {
  insertPastedTextChip(
    editor,
    {
      label: prompt.name,
      source: "prompt",
      text: prompt.body,
    },
    { replaceRange: range },
  );
};

const PLUGIN_NAME = "promptSlash";

type PromptSlashOptions = {
  suggestion: Omit<SuggestionOptions<ChatPrompt, ChatPrompt>, "editor">;
};

/**
 * `/`-triggered TipTap extension that lets the user pick a saved
 * prompt and drop it into the composer as a collapsible chip.
 * Triggers when `/` is typed at the start of a paragraph or after
 * whitespace, so a `/` inside a URL (e.g. `https://...`) is just a
 * slash. Selection inserts a `pastedText` chip carrying the prompt
 * name as the label and the body as the underlying text — same
 * visual treatment as a long paste, so a multi-paragraph skill
 * doesn't dump a wall of text into the input.
 */
export const PromptSlash = Extension.create<PromptSlashOptions>({
  name: PLUGIN_NAME,

  addOptions() {
    return {
      suggestion: {
        char: "/",
        allowSpaces: false,
        items: () => [],
        command: ({ editor, range, props }) => {
          insertPromptAsChip(editor, range, props);
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
      prompt.command?.toLowerCase().includes(trimmed) === true ||
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
  allowSpaces: false,
  items: ({ query }) => filterPrompts(getPrompts(), query),

  command: ({ editor, range, props }) => {
    insertPromptAsChip(editor, range, props);
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
