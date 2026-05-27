import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { insertPastedTextChip } from "@/components/chat-pasted-text-extension";
import { PromptSlashList } from "@/components/chat/prompt-slash-list";
import type { ChatPrompt, PromptScope } from "@/lib/prompts/types";

export type SlashSkill = {
  id: string;
  name: string;
  /** Slug used by the AI's `load-skill` tool. */
  slug: string;
  description: string;
  scope: PromptScope;
};

export type SlashItem =
  | { kind: "prompt"; prompt: ChatPrompt }
  | { kind: "skill"; skill: SlashSkill };

const insertSlashItem = (
  editor: Editor,
  range: { from: number; to: number },
  item: SlashItem,
) => {
  if (item.kind === "prompt") {
    insertPastedTextChip(
      editor,
      {
        label: item.prompt.name,
        source: "prompt",
        text: item.prompt.body,
      },
      { replaceRange: range },
    );
    return;
  }

  insertPastedTextChip(
    editor,
    {
      label: item.skill.name,
      source: "skill",
      text: item.skill.slug,
    },
    { replaceRange: range },
  );
};

const PLUGIN_NAME = "promptSlash";

type PromptSlashOptions = {
  suggestion: Omit<SuggestionOptions<SlashItem, SlashItem>, "editor">;
};

/**
 * `/`-triggered TipTap extension that lets the user pick a saved
 * prompt or installed skill and drop it into the composer as a
 * collapsible chip. Triggers when `/` is typed at the start of a
 * paragraph or after whitespace, so a `/` inside a URL (e.g.
 * `https://...`) is just a slash. Prompts insert their body
 * verbatim; skills insert a short directive that nudges the model
 * to call `load-skill` on the next turn.
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
          insertSlashItem(editor, range, props);
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

const matchesQuery = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle);

const filterItems = (items: SlashItem[], query: string): SlashItem[] => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return items;
  }
  return items.filter((item) => {
    if (item.kind === "prompt") {
      const { name, command, body } = item.prompt;
      return (
        matchesQuery(name, trimmed) ||
        (command !== undefined && matchesQuery(command, trimmed)) ||
        matchesQuery(body, trimmed)
      );
    }
    const { name, slug, description } = item.skill;
    return (
      matchesQuery(name, trimmed) ||
      matchesQuery(slug, trimmed) ||
      matchesQuery(description, trimmed)
    );
  });
};

/**
 * Build the Suggestion config used by `PromptSlash`. `getItems`
 * is read on every keystroke so the host can mix prompts and skills
 * (and any future kinds) without re-creating the extension.
 */
export const createPromptSlashSuggestion = (
  getItems: () => SlashItem[],
): Omit<SuggestionOptions<SlashItem, SlashItem>, "editor"> => ({
  char: "/",
  allowSpaces: false,
  items: ({ query }) => filterItems(getItems(), query),

  command: ({ editor, range, props }) => {
    insertSlashItem(editor, range, props);
  },

  render: () => {
    let component: ReactRenderer<
      ReturnType<NonNullable<SuggestionOptions["render"]>>,
      SuggestionProps<SlashItem>
    > | null = null;

    return {
      onStart: (props: SuggestionProps<SlashItem>) => {
        if (!props.clientRect) {
          return;
        }
        component = new ReactRenderer(PromptSlashList, {
          props,
          editor: props.editor,
        });
      },
      onUpdate: (props: SuggestionProps<SlashItem>) => {
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
