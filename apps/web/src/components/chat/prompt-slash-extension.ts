import { Extension, isNodeEmpty } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { insertPastedTextChip } from "@/components/chat-pasted-text-extension";
import type { PastedTextAttrs } from "@/components/chat-pasted-text-extension";
import { PromptSlashList } from "@/components/chat/prompt-slash-list";
import type { ChatPrompt, PromptScope } from "@/lib/prompts/types";
import type { ReservedChatCommand } from "@/lib/reserved-chat-commands";

export type SlashSkillScope = PromptScope | "built-in";

export type SlashSkill = {
  id: string;
  name: string;
  /** Slug used by the AI's `load-skill` tool. */
  slug: string;
  description: string;
  scope: SlashSkillScope;
};

export type SlashItem =
  | { kind: "prompt"; prompt: ChatPrompt }
  | { kind: "skill"; skill: SlashSkill }
  | { kind: "command"; command: ReservedChatCommand };

/**
 * Build the pasted-text chip attrs a slash item inserts. Shared by the
 * `/`-triggered suggestion (which replaces the typed trigger range) and the
 * composer (+) menu's Skills submenu (which inserts at the cursor with no
 * range to replace) so both surfaces produce the identical chip.
 */
export const slashItemChipAttrs = (item: SlashItem): PastedTextAttrs => {
  if (item.kind === "command") {
    return {
      label: item.command.name,
      source: "command",
      text: item.command.command,
    };
  }

  if (item.kind === "prompt") {
    return {
      label: item.prompt.name,
      source: "prompt",
      text: item.prompt.body,
    };
  }

  return {
    label: item.skill.name,
    source: "skill",
    text: item.skill.slug,
  };
};

const insertSlashItem = (
  editor: Editor,
  range: { from: number; to: number },
  item: SlashItem,
) => {
  insertPastedTextChip(editor, slashItemChipAttrs(item), {
    replaceRange: range,
  });
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

const matchesQuery = (
  haystack: string | null | undefined,
  needle: string,
): boolean => (haystack ? haystack.toLowerCase().includes(needle) : false);

const filterItems = (items: SlashItem[], query: string): SlashItem[] => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return items;
  }
  return items.filter((item) => {
    if (item.kind === "command") {
      const { name, command } = item.command;
      return matchesQuery(name, trimmed) || matchesQuery(command, trimmed);
    }
    if (item.kind === "prompt") {
      const { name, command, body } = item.prompt;
      return (
        matchesQuery(name, trimmed) ||
        matchesQuery(command, trimmed) ||
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
 * Whether the document has any real content before `to` -- mirrors
 * `editor.isEmpty` (the outer composer's own emptiness gate in
 * chat-input-surface.tsx), which treats an atom node (a mention or
 * pasted-text chip) as content, same as TipTap's own `isNodeEmpty`. A
 * `textBetween` + `.trim()` check instead reduces every chip to its
 * leaf-text placeholder ("\n"), which trims away to "" -- so a chip-only
 * composer read as empty and "/" right after a chip fell through to a
 * literal character instead of opening the suggestion. Exported for
 * testing.
 */
export const hasContentBefore = (doc: ProseMirrorNode, to: number): boolean =>
  !isNodeEmpty(doc.cut(0, to));

/**
 * Build the Suggestion config used by `PromptSlash`. `getItems`
 * is read on every keystroke so the host can mix prompts and skills
 * (and any future kinds) without re-creating the extension.
 */
type CreatePromptSlashSuggestionOptions = {
  suppressEmptyTrigger?: boolean | undefined;
};

export const createPromptSlashSuggestion = (
  getItems: () => SlashItem[],
  options?: CreatePromptSlashSuggestionOptions,
): Omit<SuggestionOptions<SlashItem, SlashItem>, "editor"> => ({
  char: "/",
  allowSpaces: false,
  allow: ({ range, state }) =>
    !options?.suppressEmptyTrigger || hasContentBefore(state.doc, range.from),
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
