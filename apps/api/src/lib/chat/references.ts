import type { ResourceRef } from "@stll/api-contract";

export { CHAT_REFERENCE_HREF_PREFIXES } from "@stll/api-contract";
export type { ChatMentionHref } from "@stll/api-contract";

type BaseChatMention = {
  id: string;
  label: string;
};

export type ChatMention =
  | (BaseChatMention & {
      category: "entity";
      resource: ResourceRef<"entity">;
      workspaceId: string | null;
    })
  | (BaseChatMention & {
      category: "workspace";
      resource: ResourceRef<"workspace">;
    });

export type ChatMentionsData = {
  mentions: ChatMention[];
};
