import MentionExtension from "@tiptap/extension-mention";
import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import {
  mergeAttributes,
  ReactNodeViewRenderer,
  ReactRenderer,
} from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { MentionList } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/mention-list";
import { MentionNode } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/mention-node";

// don't change this type, tiptap expects id and label
// otherwise mention-node won't have correct attributes
export type MentionOption = {
  id: string;
  label: string;
};

export const CustomMention = MentionExtension.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MentionNode);
  },
  parseHTML() {
    return [
      {
        tag: "mention-component",
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mention-component", mergeAttributes(HTMLAttributes)];
  },
});

export const createSuggestion = (
  mentionItems: MentionOption[],
): Omit<SuggestionOptions<MentionOption, MentionNodeAttrs>, "editor"> => ({
  allowSpaces: true,
  items: ({ query }) =>
    mentionItems.filter((item) =>
      item.label.toLowerCase().includes(query.toLowerCase()),
    ),

  render: () => {
    let component: ReactRenderer<
      ReturnType<NonNullable<SuggestionOptions["render"]>>,
      SuggestionProps<MentionOption>
    > | null = null;

    return {
      onStart: (props) => {
        if (!props.clientRect) {
          return;
        }

        component = new ReactRenderer(MentionList, {
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
