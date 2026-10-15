import MentionExtension from "@tiptap/extension-mention";
import { mergeAttributes, ReactNodeViewRenderer } from "@tiptap/react";

import type { EntityKind, ResourceRef } from "@stll/api-contract";

import { ChatMentionNode } from "@/components/chat-mention-node";

export type { ChatMentionCategory as MentionCategory } from "@/lib/api-contract";

type ChatMentionOptionBase = {
  label: string;
  mimeType: string | null;
};

export type ChatMentionOption =
  | (ChatMentionOptionBase & {
      category: "entity";
      kind: EntityKind;
      resource: ResourceRef<"entity">;
      /** Set when the entity comes from a different workspace
       *  (e.g. drill-down). Serialized into the mention node so the
       *  backend can recover workspace context while keeping model-facing
       *  markdown clean. */
      sourceWorkspaceId?: string;
      /** The matter the entity lives in, always: the chip paints its glyph
       *  in this matter's colour. Presentation only; the API drops it. */
      matterId: string;
    })
  | (ChatMentionOptionBase & {
      category: "workspace";
      kind: "workspace";
      resource: ResourceRef<"workspace">;
      sourceViewId?: string;
    })
  | (ChatMentionOptionBase & {
      category: "decision";
      kind: "decision";
      resource: ResourceRef<"case_law_decision">;
    });

export type ChatReferenceCategory = ChatMentionOption["category"];

export type ChatWorkspaceMentionOption = Extract<
  ChatMentionOption,
  { category: "workspace" }
>;

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
      matterId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.dataset["matterId"],
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs["matterId"] === "string"
            ? { "data-matter-id": attrs["matterId"] }
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
  // Only the chip node: the composer (+) menu's "@" shortcut is the one
  // picker, so tiptap's inline suggestion plugin is never installed.
  addProseMirrorPlugins() {
    return [];
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
