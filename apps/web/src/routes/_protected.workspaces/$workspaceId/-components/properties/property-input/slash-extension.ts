import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { SlashList } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/slash-list";

export type SlashItem =
  | {
      kind: "prompt";
      id: string;
      label: string;
      body: string;
    }
  | {
      kind: "skill";
      id: string;
      label: string;
      slug: string;
      description: string;
    };

const insertSlashItem = (
  editor: Editor,
  range: { from: number; to: number },
  item: SlashItem,
) => {
  const text =
    item.kind === "prompt"
      ? item.body
      : `Use the ${item.label} skill (${item.slug}): ${item.description}`;
  editor.chain().focus().deleteRange(range).insertContent(text).run();
};

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
    if (item.kind === "prompt") {
      return (
        matchesQuery(item.label, trimmed) || matchesQuery(item.body, trimmed)
      );
    }
    return (
      matchesQuery(item.label, trimmed) ||
      matchesQuery(item.slug, trimmed) ||
      matchesQuery(item.description, trimmed)
    );
  });
};

type PropertySlashOptions = {
  suggestion: Omit<SuggestionOptions<SlashItem, SlashItem>, "editor">;
};

export const PropertySlash = Extension.create<PropertySlashOptions>({
  name: "propertySlash",

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

export const createPropertySlashSuggestion = (
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
      onStart: (props) => {
        if (!props.clientRect) {
          return;
        }
        component = new ReactRenderer(SlashList, {
          props,
          editor: props.editor,
        });
      },
      onUpdate: (props) => {
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
