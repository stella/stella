import MentionExtension from "@tiptap/extension-mention";
import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import {
  mergeAttributes,
  ReactNodeViewRenderer,
  ReactRenderer,
} from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { ChatMentionList } from "@/components/chat-mention-list";
import { ChatMentionNode } from "@/components/chat-mention-node";
import type { MentionCategory } from "@/components/chat/chat-mention-href";

export type { MentionCategory } from "@/components/chat/chat-mention-href";

export type ChatReferenceCategory = MentionCategory | "decision";

export type ChatMentionOption = {
  id: string;
  label: string;
  category: ChatReferenceCategory;
  /** Entity kind (document, folder, etc.) or workspace. */
  kind: string;
  mimeType: string | null;
  sourceViewId?: string;
  /** Set when the entity comes from a different workspace
   *  (e.g. drill-down). Serialized into the mention node so the
   *  backend can recover workspace context while keeping model-facing
   *  markdown clean. */
  sourceWorkspaceId?: string;
};

export const ChatMention = MentionExtension.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      category: {
        default: "entity",
        parseHTML: (el: HTMLElement) => el.dataset["category"] ?? "entity",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-category": attrs["category"],
        }),
      },
      kind: {
        default: "document",
        parseHTML: (el: HTMLElement) => el.dataset["kind"] ?? "document",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-kind": attrs["kind"],
        }),
      },
      mimeType: {
        default: null,
        parseHTML: (el: HTMLElement) => el.dataset["mimeType"],
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs["mimeType"] === "string"
            ? { "data-mime-type": attrs["mimeType"] }
            : {},
      },
      sourceWorkspaceId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.dataset["sourceWorkspaceId"],
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs["sourceWorkspaceId"] === "string"
            ? { "data-source-workspace-id": attrs["sourceWorkspaceId"] }
            : {},
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ChatMentionNode);
  },
  parseHTML() {
    return [{ tag: "entity-mention" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["entity-mention", mergeAttributes(HTMLAttributes)];
  },
});

const MAX_SUGGESTIONS_PER_CATEGORY = 5;
const MAX_TOTAL_SUGGESTIONS = 15;

type SelectChatSuggestionItemsOptions = {
  localItems: ChatMentionOption[];
  query: string;
  searchedItems: ChatMentionOption[];
};

export const selectChatSuggestionItems = ({
  localItems,
  query,
  searchedItems,
}: SelectChatSuggestionItemsOptions): ChatMentionOption[] => {
  const lower = query.toLowerCase();

  const filteredLocalItems = lower
    ? localItems.filter((item) => item.label.toLowerCase().includes(lower))
    : localItems;
  const all = [...filteredLocalItems, ...searchedItems];

  // Cap per category to keep the list balanced
  const counts = new Map<ChatReferenceCategory, number>();
  const result: ChatMentionOption[] = [];

  for (const item of all) {
    const count = counts.get(item.category) ?? 0;
    if (count >= MAX_SUGGESTIONS_PER_CATEGORY) {
      continue;
    }
    counts.set(item.category, count + 1);
    result.push(item);
    if (result.length >= MAX_TOTAL_SUGGESTIONS) {
      break;
    }
  }

  return result;
};

export const createChatSuggestion = (
  getItems: () => ChatMentionOption[],
  searchItems: (query: string) => Promise<ChatMentionOption[]>,
  loadWorkspaceEntities: (
    workspace: ChatMentionOption,
    query: string,
  ) => Promise<ChatMentionOption[]>,
): Omit<SuggestionOptions<ChatMentionOption, MentionNodeAttrs>, "editor"> => ({
  allowSpaces: true,
  items: async ({ query }) =>
    selectChatSuggestionItems({
      localItems: getItems(),
      query,
      searchedItems: await searchItems(query),
    }),

  render: () => {
    let component: ReactRenderer<
      ReturnType<NonNullable<SuggestionOptions["render"]>>,
      SuggestionProps<ChatMentionOption>
    > | null = null;

    return {
      onStart: (props) => {
        if (!props.clientRect) {
          return;
        }

        component = new ReactRenderer(ChatMentionList, {
          props: {
            ...props,
            loadWorkspaceEntities,
          },
          editor: props.editor,
        });
      },

      onUpdate(props) {
        component?.updateProps(props);
      },

      onKeyDown(props) {
        return !!component?.ref?.onKeyDown?.(props);
      },

      onExit() {
        component?.destroy();
      },
    };
  },
});
