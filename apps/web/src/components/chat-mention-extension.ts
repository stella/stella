import {
  default as MentionExtension,
  type MentionNodeAttrs,
} from "@tiptap/extension-mention";
import {
  mergeAttributes,
  ReactNodeViewRenderer,
  ReactRenderer,
} from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { ChatMentionList } from "@/components/chat-mention-list";
import { ChatMentionNode } from "@/components/chat-mention-node";

export type ChatMentionOption = {
  id: string;
  label: string;
  kind: string;
  mimeType: string | null;
};

export const ChatMention = MentionExtension.extend({
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

export const createChatSuggestion = (
  getItems: () => ChatMentionOption[],
): Omit<SuggestionOptions<ChatMentionOption, MentionNodeAttrs>, "editor"> => ({
  allowSpaces: true,
  items: ({ query }) => {
    const lower = query.toLowerCase();
    return getItems()
      .filter((item) => item.label.toLowerCase().includes(lower))
      .slice(0, 10);
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
          props,
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
