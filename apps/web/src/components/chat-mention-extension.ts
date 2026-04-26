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

export type ChatMentionOption = {
  id: string;
  label: string;
  category: MentionCategory;
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

export const createChatSuggestion = (
  getItems: () => ChatMentionOption[],
  loadWorkspaceEntities: (
    workspace: ChatMentionOption,
  ) => Promise<ChatMentionOption[]>,
): Omit<SuggestionOptions<ChatMentionOption, MentionNodeAttrs>, "editor"> => ({
  allowSpaces: true,
  items: ({ query }) => {
    const lower = query.toLowerCase();
    const all = getItems();

    // Empty query: show top items per category
    // Non-empty: filter across all categories
    const filtered = lower
      ? all.filter((item) => item.label.toLowerCase().includes(lower))
      : all;

    // Cap per category to keep the list balanced
    const counts = new Map<MentionCategory, number>();
    const result: ChatMentionOption[] = [];

    for (const item of filtered) {
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
  },

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
