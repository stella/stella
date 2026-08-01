export const CHAT_MENTION_CATEGORIES = ["entity", "workspace"] as const;

export type ChatMentionCategory = (typeof CHAT_MENTION_CATEGORIES)[number];

export type ChatMentionHrefPrefix = `#stella-${ChatMentionCategory}=`;

export type ChatMentionHref = `${ChatMentionHrefPrefix}${string}`;

export type ChatMentionHrefPrefixMap = {
  [TCategory in ChatMentionCategory]: `#stella-${TCategory}=`;
};

export const CHAT_MENTION_HREF_PREFIXES = {
  entity: "#stella-entity=",
  workspace: "#stella-workspace=",
} as const satisfies ChatMentionHrefPrefixMap;

export const CHAT_REFERENCE_HREF_PREFIXES = {
  ...CHAT_MENTION_HREF_PREFIXES,
  decision: "#stella-decision=",
} as const;

export type ChatReferenceHrefPrefix =
  (typeof CHAT_REFERENCE_HREF_PREFIXES)[keyof typeof CHAT_REFERENCE_HREF_PREFIXES];

export type ChatReferenceCategory = keyof typeof CHAT_REFERENCE_HREF_PREFIXES;

type BaseChatMention = {
  id: string;
  label: string;
};

export type ChatMention =
  | (BaseChatMention & {
      category: "entity";
      workspaceId: string | null;
    })
  | (BaseChatMention & { category: "workspace" });

export type ChatMentionsData = {
  mentions: ChatMention[];
};
